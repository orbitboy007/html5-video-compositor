import VideoSource from "./sources/videosource.js";
import ImageSource from "./sources/imagesource.js";
import CanvasSource from "./sources/canvassource.js";


let updateables = [];
let previousTime = undefined;
let mediaSourceMapping = new Map();
mediaSourceMapping.set("video",VideoSource).set("image",ImageSource).set("canvas",CanvasSource);


function registerUpdateable(updateable){
    updateables.push(updateable);
}
function update(time){
    if (previousTime === undefined) previousTime = time;
    let dt = (time - previousTime)/1000;
    for(let i = 0; i < updateables.length; i++){
        updateables[i].update(dt);
    }
    previousTime = time;
    requestAnimationFrame(update);
}
update();


class VideoCompositor {
    constructor(canvas){
        this._canvas = canvas;
        this._ctx = this._canvas.getContext('webgl');
        this._playing = false;
        this._mediaSources = new Map();
        this._mediaSourcePreloadNumber = 2; // define how many mediaSources to preload. This is influenced by the number of simultanous AJAX requests available.
        this._playlist = undefined;
        this._eventMappings = new Map();
        this._effectShaderPrograms = new Map();
        this._transitionShaderPrograms = new Map();

        //Setup the default shader effect
        let defaultEffectShader = VideoCompositor.createEffectShaderProgram(this._ctx);
        this._effectShaderPrograms.set("default", defaultEffectShader);

        this._currentTime = 0;
        this.duration = 0;
        registerUpdateable(this);
    }

    set currentTime(currentTime){
        console.log("Seeking to", currentTime);
        if (this._playlist === undefined){
            return;
        }
        let [toPlay, currentlyPlaying, finishedPlaying] = this._getPlaylistPlayingStatusAtTime(this._playlist, currentTime);

        //clean-up any currently playing mediaSources
        this._mediaSources.forEach(function(mediaSource, id, mediaSources){
            mediaSource.destroy();
        });
        this._mediaSources.clear();

        //Load mediaSources
        for (let i = 0; i < currentlyPlaying.length; i++) {
            let mediaSourceID = currentlyPlaying[i].id;
            //If the media source isn't loaded then we start loading it.
            if (this._mediaSources.has(mediaSourceID) === false){
                
                var _this = this;
                this._loadMediaSource(currentlyPlaying[i], function(mediaSource){
                    //let mediaSource = _this._mediaSources.get(mediaSourceID);
                    mediaSource.seek(currentTime);
                });

                

            }else{
               //If the mediaSource is loaded then we seek to the proper bit
                this._mediaSources.get(mediaSourceID).seek(currentTime);
            }

        };

        this._currentTime = currentTime;
        let seekEvent = new CustomEvent('seek', {detail:{data:currentTime, instance:this}});
        this._canvas.dispatchEvent(seekEvent);
    }

    get currentTime(){
        return this._currentTime;
    }
    
    set playlist(playlist){
        VideoCompositor.validatePlaylist(playlist);
        this.duration = VideoCompositor.calculatePlaylistDuration(playlist);
        this._playlist = playlist;
        //clean-up any currently playing mediaSources
        this._mediaSources.forEach(function(mediaSource, id, mediaSources){
            mediaSource.destroy();
        });
        this._mediaSources.clear();
    }

    play(){
        this._playing = true;
        let playEvent = new CustomEvent('play', {detail:{data:this._currentTime, instance:this}});
        this._canvas.dispatchEvent(playEvent);
    }

    pause() {
        this._playing = false;
        this._mediaSources.forEach(function(mediaSource, id, mediaSources){
            mediaSource.pause();
        });
        let pauseEvent = new CustomEvent('pause', {detail:{data:this._currentTime, instance:this}});
        this._canvas.dispatchEvent(pauseEvent);
    }

    addEventListener(type, func){
        //Pass through any event listeners through to the underlying canvas rendering element
        //Catch any events and handle with a custom events dispatcher so things 
        if (this._eventMappings.has(type)){
            this._eventMappings.get(type).push(func);
        }else {
            this._eventMappings.set(type, [func]);
        }
        this._canvas.addEventListener(type, this._dispatchEvents, false);
    }

    _dispatchEvents(evt){
        //Catch events and pass them on, mangling the detail property so it looks nice in the API
        for (let i = 0; i < evt.detail.instance._eventMappings.get(evt.type).length; i++){
            evt.detail.instance._eventMappings.get(evt.type)[i](evt.detail.data);
        }
    }

    _getPlaylistPlayingStatusAtTime(playlist, playhead){
        let toPlay = [];
        let currentlyPlaying = [];
        let finishedPlaying = [];

        //itterate tracks
        for(let i = 0; i < playlist.tracks.length; i++){
            let track = playlist.tracks[i];
            for (let j = 0; j < track.length; j++) {
                let segment = track[j];
                let segmentEnd = segment.start+segment.duration;

                if (playhead > segmentEnd){
                    finishedPlaying.push(segment);
                    continue;
                }
                if (playhead > segment.start && playhead < segmentEnd){
                    currentlyPlaying.push(segment);
                    continue;
                }
                if(playhead <= segment.start){
                    toPlay.push(segment);
                    continue;
                }
            };
        }

        return [toPlay, currentlyPlaying, finishedPlaying];
    }

    _sortMediaSourcesByStartTime(mediaSources){
        mediaSources.sort(function(a,b){
            return a.start - b.start;
        });
        return mediaSources;
    }


    _getEffectShaderProgramForMediaSource(mediaSourceID){
        let effects = this._playlist.effects;
        let defaultEffectShader = this._effectShaderPrograms.get("default")

        if (effects === undefined){
            //No effects defined so just use default shader
            return defaultEffectShader;
        }

        for (let effectKey of Object.keys(effects)){
            
            let effect = effects[effectKey];
            if (effect.inputs.indexOf(mediaSourceID) > -1){
                //Found effect for mediaSourceID
                //Check if program for effect is compiled.
                if (this._effectShaderPrograms.has(effect.effect.id)){
                    return this._effectShaderPrograms.get(effect.effect.id);
                }else {
                    let effectShader = VideoCompositor.createEffectShaderProgram(this._ctx, effect);
                    this._effectShaderPrograms.set(effect.effect.id, effectShader);
                    return effectShader;
                }
            }
        }

        //if wer get top this point no suitable effect shader was found so just return the default
        return defaultEffectShader;
    }

    _loadMediaSource(mediaSourceReference, onReadyCallback){
        if (onReadyCallback === undefined) onReadyCallback = function(mediaSource){};

        switch (mediaSourceReference.type){
            case "video":
                let video = new VideoSource(mediaSourceReference, this._ctx);
                video.onready = onReadyCallback;
                video.load();
                this._mediaSources.set(mediaSourceReference.id, video);
                break;
            case "image":
                let image = new ImageSource(mediaSourceReference, this._ctx);
                image.onready = onReadyCallback;
                image.load();
                this._mediaSources.set(mediaSourceReference.id, image);
                break;
            case "canvas":
                let canvas = new CanvasSource(mediaSourceReference, this._ctx);
                canvas.onready = onReadyCallback;
                canvas.load();
                this._mediaSources.set(mediaSourceReference.id, canvas);
                break;
            default:
                throw {"error":5,"msg":"mediaSourceReference "+mediaSourceReference.id+" has unrecognized type "+mediaSourceReference.type, toString:function(){return this.msg;}};
                break;
        }
    }

    update(dt){
        if (this._playlist === undefined || this._playing === false) return;

        let [toPlay, currentlyPlaying, finishedPlaying] = this._getPlaylistPlayingStatusAtTime(this._playlist, this._currentTime);
        toPlay = this._sortMediaSourcesByStartTime(toPlay);

        //Check if we've finished playing and then stop
        if (toPlay.length === 0 && currentlyPlaying.length === 0){
            this.pause();
            let endedEvent = new CustomEvent('ended', {detail:{data:this.currentTime, instance:this}});
            this.currentTime = 0;
            this._canvas.dispatchEvent(endedEvent);
            return;
        }


        //Preload mediaSources
        for (let i = 0; i < this._mediaSourcePreloadNumber; i++) {
            if (i === toPlay.length) break;
            if (this._mediaSources.has(toPlay[i].id) === false){
                this._loadMediaSource(toPlay[i]);
            }
        };

        //Clean-up any mediaSources which have already been played
        for (let i = 0; i < finishedPlaying.length; i++) {
            let mediaSourceReference = finishedPlaying[i];
            if (this._mediaSources.has(mediaSourceReference.id)){
                let mediaSource = this._mediaSources.get(mediaSourceReference.id);
                mediaSource.destroy();
                this._mediaSources.delete(mediaSourceReference.id);
            }
        };

        //Make sure all mediaSources are ready to play
        let ready = true;
        for (let i = 0; i < currentlyPlaying.length; i++) {
            let mediaSourceID = currentlyPlaying[i].id;
            //check that currently playing mediaSource exists
            if (!this._mediaSources.has(mediaSourceID)){
                //if not load it
                this._loadMediaSource(currentlyPlaying[i]);
                ready = false;
                continue;
            }
            if (!this._mediaSources.get(mediaSourceID).isReady()) ready=false;
        }
        //if all the sources aren't ready, exit function before rendering or advancing clock.
        if (ready === false){
            return;
        }


        //Play mediaSources on the currently playing queue.
        let w = this._canvas.width;
        let h = this._canvas.height;
        currentlyPlaying.reverse(); //reverse the currently playing queue so track 0 renders last




        for (let i = 0; i < currentlyPlaying.length; i++) {
            let mediaSourceID = currentlyPlaying[i].id;
            let mediaSource = this._mediaSources.get(mediaSourceID);
            mediaSource.play();

            var effectShaderProgram = this._getEffectShaderProgramForMediaSource(mediaSourceID);
            mediaSource.render(effectShaderProgram);
            //this._ctx.drawImage(mediaSource.render(), 0, 0, w, h);
        };
        this._currentTime += dt;
    }



    static calculateTrackDuration(track){
        let maxPlayheadPosition = 0;
        for (let j = 0; j < track.length; j++) {
            let playheadPosition = track[j].start + track[j].duration;
            if (playheadPosition > maxPlayheadPosition){
                maxPlayheadPosition = playheadPosition;
            }
        };
        return maxPlayheadPosition;
    }

    static calculatePlaylistDuration(playlist){
        let maxTrackDuration = 0;

        for(let i = 0; i < playlist.tracks.length; i++){
            let track = playlist.tracks[i];
            let trackDuration = VideoCompositor.calculateTrackDuration(track);
            if (trackDuration > maxTrackDuration){
                maxTrackDuration = trackDuration;
            }
        }

        return maxTrackDuration;
    }

    static validatePlaylist(playlist){
        /*     
        This function validates a passed playlist, making sure it matches a 
        number of properties a playlist must have to be OK.

        * Error 1. MediaSourceReferences have a unique ID        
        * Error 2. The playlist media sources have all the expected properties.
        * Error 3. MediaSourceReferences in single track are sequential.
        * Error 4. MediaSourceReferences in single track don't overlap
        */

        //Error 1. MediaSourceReferences have a unique ID
        let IDs = new Map();
        for (let i = 0; i < playlist.tracks.length; i++) {
            let track = playlist.tracks[i]
            for (let j = 0; j < track.length; j++) {
                let MediaSourceReference = track[j];
                if (IDs.has(MediaSourceReference.id)){
                    throw {"error":1,"msg":"MediaSourceReference "+MediaSourceReference.id+" in track " +i+" has a duplicate ID.", toString:function(){return this.msg;}};
                }else{
                    IDs.set(MediaSourceReference.id, true);
                }
            }
        }


        //Error 2. The playlist MediaSourceReferences have all the expected properties.
        for (let i = 0; i < playlist.tracks.length; i++) {
            let track = playlist.tracks[i]
            for (let j = 0; j < track.length; j++) {
                let MediaSourceReference = track[j];
                if (MediaSourceReference.id === undefined) throw {"error":2,"msg":"MediaSourceReference "+MediaSourceReference.id+" in track " +i+" is missing a id property", toString:function(){return this.msg;}};
                if (MediaSourceReference.start === undefined) throw {"error":2,"msg":"MediaSourceReference "+MediaSourceReference.id+" in track " +i+" is missing a start property", toString:function(){return this.msg;}};
                if (MediaSourceReference.duration === undefined) throw {"error":2,"msg":"MediaSourceReference "+MediaSourceReference.id+" in track " +i+" is missing a duration property", toString:function(){return this.msg;}};
                if (MediaSourceReference.type === undefined) throw {"error":2,"msg":"MediaSourceReference "+MediaSourceReference.id+" in track " +i+" is missing a type property", toString:function(){return this.msg;}};
                if (MediaSourceReference.src != undefined && MediaSourceReference.element != undefined)throw {"error":2,"msg":"MediaSourceReference "+MediaSourceReference.id+" in track " +i+" has both a src and element, it must have one or the other", toString:function(){return this.msg;}};
                if (MediaSourceReference.src === undefined && MediaSourceReference.element === undefined)throw {"error":2,"msg":"MediaSourceReference "+MediaSourceReference.id+" in track " +i+" has neither a src or an element, it must have one or the other", toString:function(){return this.msg;}};                
            }
        }


        // Error 3. MediaSourceReferences in single track are sequential.
        for (let i = 0; i < playlist.tracks.length; i++) {
            let track = playlist.tracks[i]
            let time = 0;
            for (let j = 0; j < track.length; j++) {
                let MediaSourceReference = track[j];
                if (MediaSourceReference.start < time){
                    throw {"error":3,"msg":"MediaSourceReferences "+MediaSourceReference.id+" in track " +i+" starts before previous MediaSourceReference", toString:function(){return this.msg;}};
                }
                time = MediaSourceReference.start;
            }
        }        


        //Error 4. MediaSourceReferences in single track don't overlap
        for (let i = 0; i < playlist.tracks.length; i++) {
            let track = playlist.tracks[i]
            let previousMediaSourceReference = undefined;
            for (let j = 0; j < track.length; j++) {
                let MediaSourceReference = track[j];
                if (previousMediaSourceReference === undefined){
                    previousMediaSourceReference = MediaSourceReference;
                    continue;
                }
                let previousEnd = previousMediaSourceReference.start + previousMediaSourceReference.duration;
                let currentStart = MediaSourceReference.start;
                if (previousEnd > currentStart){
                    throw {"error":4,"msg":"Track MediaSourceReferences overlap. MediaSourceReference "+previousMediaSourceReference.id+" in track " +i+" finishes after MediaSourceReference " + MediaSourceReference.id +" starts.", toString:function(){return this.msg;}};
                }
            }
        }
    }






    static createEffectShaderProgram(gl, effect){
        let vertexShaderSource = "\
            attribute vec2 a_position;\
            attribute vec2 a_texCoord;\
            varying vec2 v_texCoord;\
            \
            void main() {\
                gl_Position = vec4(2.0*a_position-1.0, 0.0, 1.0);\
                v_texCoord = a_texCoord;\
            }";

        let fragmentShaderSource = "\
            precision mediump float;\
            uniform sampler2D u_image;\
            varying vec2 v_texCoord;\
            void main(){\
                gl_FragColor = texture2D(u_image, v_texCoord)*vec4(1.0,1.0,1.0,1.0);\
            }";

        if (effect !== undefined){
            if (effect.effect.fragmentShader !== undefined) fragmentShaderSource = effect.effect.fragmentShader;
            if (effect.effect.vertexShader !== undefined) vertexShaderSource = effect.effect.vertexShader;    
        }
        
        let program = VideoCompositor.createShaderProgram(gl, vertexShaderSource, fragmentShaderSource);
        return program;
        gl.useProgram(program);
    }


    static createShaderProgram(gl, vertexShaderSource, fragmentShaderSource){
        let vertexShader = VideoCompositor.compileShader(gl, vertexShaderSource, gl.VERTEX_SHADER);
        let fragmentShader = VideoCompositor.compileShader(gl, fragmentShaderSource, gl.FRAGMENT_SHADER);
        let program = gl.createProgram();

        gl.attachShader(program, vertexShader);
        gl.attachShader(program, fragmentShader);
        gl.linkProgram(program);

        if (!gl.getProgramParameter(program, gl.LINK_STATUS)){
            throw {"error":4,"msg":"Can't link shader program for track "+trackIndex, toString:function(){return this.msg;}};
        }
        return program;
    }


    static compileShader(gl, shaderSource, shaderType) {
        var shader = gl.createShader(shaderType);
        gl.shaderSource(shader, shaderSource);
        gl.compileShader(shader);
        var success = gl.getShaderParameter(shader, gl.COMPILE_STATUS);
        if (!success) {
            throw "could not compile shader:" + gl.getShaderInfoLog(shader);
        }
        return shader;
    }


    static renderPlaylist(playlist, canvas, currentTime){
        let ctx = canvas.getContext('2d');
        let w = canvas.width;
        let h = canvas.height;
        let trackHeight = h / playlist.tracks.length;
        let playlistDuration = VideoCompositor.calculatePlaylistDuration(playlist);
        let pixelsPerSecond = w / playlistDuration;
        let mediaSourceStyle = {
            "video":"#a5a",
            "image":"#5aa",
            "canvas":"#aa5",
        }


        ctx.clearRect(0,0,w,h);
        ctx.fillStyle = "#999";
        for (let i = 0; i < playlist.tracks.length; i++) {
            let track = playlist.tracks[i];
            for (let j = 0; j < track.length; j++) {
                let mediaSource = track[j];
                let msW = mediaSource.duration * pixelsPerSecond;
                let msH = trackHeight;
                let msX = mediaSource.start * pixelsPerSecond;
                let msY = trackHeight * i;
                ctx.fillStyle = mediaSourceStyle[mediaSource.type];
                ctx.fillRect(msX,msY,msW,msH);
                ctx.fill();
            };
        };

        if (currentTime !== undefined){
            ctx.fillStyle = "#000";
            ctx.fillRect(currentTime*pixelsPerSecond, 0, 1, h);
        }
    }
}


VideoCompositor.Effects = {
    "MONOCHROME":{
                "id":"monochrome-filter",
                "fragmentShader":"\
                    precision mediump float;\
                    uniform sampler2D u_image;\
                    varying vec2 v_texCoord;\
                    void main(){\
                        vec4 pixel = texture2D(u_image, v_texCoord);\
                        float avg = (pixel[0]*0.2125 + pixel[1]*0.7154 + pixel[2]*0.0721)/3.0;\
                        pixel = vec4(avg*1.5, avg*1.5, avg*1.5, pixel[3]);\
                        gl_FragColor = pixel;\
                    }"
            },
    "SEPIA":{
                "id":"sepia-filter",
                "fragmentShader":"\
                    precision mediump float;\
                    uniform sampler2D u_image;\
                    varying vec2 v_texCoord;\
                    void main(){\
                        vec4 pixel = texture2D(u_image, v_texCoord);\
                        float avg = (pixel[0]*0.2125 + pixel[1]*0.7154 + pixel[2]*0.0721)/3.0;\
                        pixel = vec4(avg*2.0, avg*1.6, avg, pixel[3]);\
                        gl_FragColor = pixel;\
                    }"
            },
    "BITCRUNCH":{
                "id":"bitcrunch-filter",
                "fragmentShader":"\
                    precision mediump float;\
                    uniform sampler2D u_image;\
                    varying vec2 v_texCoord;\
                    void main(){\
                        vec4 pixel = texture2D(u_image, v_texCoord);\
                        pixel = floor(pixel*vec4(8.0,8.0,8.0,8.0));\
                        pixel = pixel/vec4(8.0,8.0,8.0,8.0);\
                        gl_FragColor = pixel*vec4(1.0,1.0,1.0,1.0);\
                    }"
                },
    //Green screen color =  r = 62, g = 178, b = 31
    //Normalised         = r = 0.243, g= 0.698, b = 0.122
    "GREENSCREENMAD":{
                "id":"greenscreen-filter",
                "fragmentShader":"\
                    precision mediump float;\
                    uniform sampler2D u_image;\
                    varying vec2 v_texCoord;\
                    void main(){\
                        vec4 pixel = texture2D(u_image, v_texCoord);\
                        float alpha = 1.0;\
                        float r = pixel[0];\
                        float g = pixel[1];\
                        float b = pixel[2];\
                        float y =  0.299*r + 0.587*g + 0.114*b;\
                        float u = -0.147*r - 0.289*g + 0.436*b;\
                        float v =  0.615*r - 0.515*g - 0.100*b;\
                        ;\
                        alpha = (v+u)*10.0 +2.0;\
                        \
                        pixel = floor(pixel*vec4(2.0,2.0,2.0,2.0));\
                        pixel = pixel/vec4(2.0,2.0,2.0,2.0);\
                        pixel = vec4(pixel[2]*2.0, pixel[1]*2.0, pixel[0]*2.0, alpha);\
                        gl_FragColor = pixel;\
                    }"
            },
    "GREENSCREEN":{
                "id":"greenscreen-filter",
                "fragmentShader":"\
                    precision mediump float;\
                    uniform sampler2D u_image;\
                    varying vec2 v_texCoord;\
                    void main(){\
                        vec4 pixel = texture2D(u_image, v_texCoord);\
                        float alpha = 1.0;\
                        float r = pixel[0];\
                        float g = pixel[1];\
                        float b = pixel[2];\
                        float y =  0.299*r + 0.587*g + 0.114*b;\
                        float u = -0.147*r - 0.289*g + 0.436*b;\
                        float v =  0.615*r - 0.515*g - 0.100*b;\
                        if (y > 0.2 && y < 0.8){\
                            alpha = (v+u)*40.0 +2.0;\
                        }\
                        pixel = vec4(pixel[0], pixel[1], pixel[2], alpha);\
                        gl_FragColor = pixel;\
                    }"
            },
}

export default VideoCompositor;