var exec = require('child_process').exec;
var fs = require('fs');
var path = require('path');
var url = require('url');
var http = require('http');
var streamify = require('streamify');
var request = require('request');
var util = require('./util');
var hms = require('hh-mm-ss');
var ytdlBinary = __dirname + '\\youtube-dl.exe'

// Check that youtube-dl file exists.

var isDebug = /^\[debug\] /;
var isWarning = /^WARNING: /;
var isYouTubeRegex = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\//;
var isNoSubsRegex = /WARNING: video doesn't have subtitles|no closed captions found/;
var videoNotAvailable = /This video is not available|This video has been removed by the user|Please sign in to view this video|This video is no longer available/;
var subsRegex = /--write-sub|--write-srt|--srt-lang|--all-subs/;

/**
 * Processes data
 *
 * @param {Object} data
 * @param {Object} options
 * @param {Object} stream
 */

function processData(data, options, stream) {

    'use strict';
    var item = (!data.length) ? data : data.shift();

    // fix for pause/resume downloads
    var headers = {
        'Host': url.parse(item.url).hostname
    };

    if (options && options.start > 0) {
        headers.Range = 'bytes=' + options.start + '-';
    }

    var req = request({
        url: item.url,
        headers: headers
    });

    req.on('response', function response(res) {

        var size = parseInt(res.headers['content-length'], 10);
        if (size) {
            item.size = size;
        }

        if (options && options.start > 0 && res.statusCode === 416) {
            // the file that is being resumed is complete.
            return stream.emit('complete', item);
        }

        if (res.statusCode !== 200 && res.statusCode !== 206) {
            return stream.emit('error', new Error('status code ' + res.statusCode));
        }

        stream.emit('info', item);

        stream.on('end', function end() {
            if (data.length) { stream.emit('next', data); }
        });

    });

    stream.resolve(req);
}

/**
 * Downloads a video.
 *
 * @param {String} videoUrl
 * @param {!Array.<String>} args
 * @param {!Object} options
 */
var ytdl = module.exports = function(videoUrl, args, options) {

    'use strict';
    var stream = streamify({
        superCtor: http.ClientResponse,
        readable: true,
        writable: false
    });

    if (typeof videoUrl !== 'string') {
        processData(videoUrl, options, stream);
        return stream;
    }

    ytdl.getInfo(videoUrl, args, options, function getInfo(err, data) {
        if (err) { return stream.emit('error', err); }
        processData(data, options, stream);
    });

    return stream;
};

/**
 * Calls youtube-dl with some arguments and the `callback`
 * gets called with the output.
 *
 * @param {String|Array.<String>}
 * @param {Array.<String>} args
 * @param {Array.<String>} args2
 * @param {Object} options
 * @param {Function(!Error, String)} callback
 */
function call(urls, args1, args2, options, callback) {
    'use strict';
    var args = args1;
    var passOver = false;
    if (args2) {
        args = args.concat(args2);
    }
    options = options || {};

    if (urls !== null) {
        if (typeof urls === 'string') {
            urls = [urls];
        }

        for (var i = 0; i < urls.length; i++) {
            var video = urls[i];
            if (isYouTubeRegex.test(video)) {
                // Get possible IDs.
                var details = url.parse(video, true);
                var id = details.query.v || '';
                if (id) {
                    args.push('"http://www.youtube.com/watch?v=' + id + '"');
                    args.unshift("best")
                    args.unshift("--format")
                    args.unshift("-v")
                     args.unshift("-i")

                } else {
                    // Get possible IDs for youtu.be from urladdr.
                    id = details.pathname.slice(1).replace(/^v\//, '');
                    if (id) {
                        if ((id === 'playlist') && !options.maxBuffer) { options.maxBuffer = 7000 * 1024; }
                            args.push(`"${video}"`);
                            args.unshift("best")
                            args.unshift("--format")
                            args.unshift("-v")
                            args.unshift("-i")



                    }
                }
            } else {
                args.push(`"${video}"`);
                args.unshift("best")
                args.unshift("--format")
                args.unshift("-v")
                args.unshift("-i")

            }
        }
    }

    // Call youtube-dl.
    exec(ytdlBinary + " "+ args.join(" "), function done(err, stdout, stderr) {
        let error = null
        if(stderr.toString().includes("ERROR")){
            if(stderr.toString().includes("This video is unavailable")){
                error =  "YOUTUBE-DL: This video is unavailable"

            }else{
                error =  "YOUTUBE-DL: Internal youtube-dl error"
            } 
        }else{
            var data = stdout.trim().split(/\r?\n/);

        }
        callback(error, data);
    });

}

/**
 * Calls youtube-dl with some arguments and the `callback`
 * gets called with the output.
 *
 * @param {String} url
 * @param {Array.<String>} args
 * @param {Object} options
 * @param {Function(!Error, String)} callback
 */
ytdl.exec = function exec(url, args, options, callback) {
    'use strict';
    return call(url, [], args, options, callback);
};


/**
 * @param {Object} data
 * @returns {Object}
 */
function parseInfo(data) {
    'use strict';
    var info = JSON.parse(data);

    // Add and process some entries to keep backwards compatibility
    Object.defineProperty(info, 'filename', {
        get: function get() {
            console.warn('`info.filename` is deprecated, use `info._filename`');
            return info._filename;
        }
    });
    Object.defineProperty(info, 'itag', {
        get: function get() {
            console.warn('`info.itag` is deprecated, use `info.format_id`');
            return info.format_id;
        }
    });
    Object.defineProperty(info, 'resolution', {
        get: function get() {
            console.warn('`info.resolution` is deprecated, use `info.format`');
            return info.format.split(' - ')[1];
        }
    });

    info._duration_raw = info.duration;
    info._duration_hms = (info.duration) ? hms.fromS(info.duration, 'hh:mm:ss') : info.duration;
    info.duration = (info.duration) ? util.formatDuration(info.duration) : info.duration;

    return info;
}


/**
 * Gets info from a video.
 *
 * @param {String} url
 * @param {Array.<String>} args
 * @param {Object} options
 * @param {Function(!Error, Object)} callback
 */
ytdl.getInfo = function getInfo(url, args, options, callback) {
    'use strict';
    if (typeof options === 'function') {
        callback = options;
        options = {};
    } else if (typeof args === 'function') {
        callback = args;
        options = {};
        args = [];
    }
    var defaultArgs = ['--dump-json'];
    if (!args || args.indexOf('-f') < 0 && args.indexOf('--format') < 0 &&
        args.every(function(a) {
            return a.indexOf('--format=') !== 0;
        })) {
        defaultArgs.push('-f');
        defaultArgs.push('best');
    }

    call(url, defaultArgs, args, options, function done(err, data) {
        if (err) { return callback(err); }
        var info;

        try {
            info = data.map(parseInfo);
        } catch (err) {
            return callback(err);
        }

        callback(null, info.length === 1 ? info[0] : info);
    });
};

/**
 * @param {String} url
 * @param {Object} options
 *   {Boolean} auto
 *   {Boolean} all
 *   {String} lang
 *   {String} cwd
 * @param {Function(!Error, Object)} callback
 */
ytdl.getSubs = function getSubs(url, options, callback) {
    'use strict';
    if (typeof options === 'function') {
        callback = options;
        options = {};
    }

    var args = ['--skip-download'];
    args.push('--write' + (options.auto ? '-auto' : '') + '-sub');
    if (options.all) {
        args.push('--all-subs');
    }
    if (options.lang) {
        args.push('--sub-lang=' + options.lang);
    }
    if (!options.warrning) {
        args.push('--no-warnings');
    }

    call(url, args, [], { cwd: options.cwd }, function(err, data) {
        if (err) { return callback(err); }

        var files = [];
        for (var i = 0, len = data.length; i < len; i++) {
            var line = data[i];
            if (line.indexOf('[info] Writing video subtitles to: ') === 0) {
                files.push(line.slice(35));
            }
        }
        callback(null, files);
    });
};

/**
 * @param {String} url
 * @param {Object} options
 *   {Boolean} all
 *   {String} cwd
 * @param {Function(!Error, Object)} callback
 */
ytdl.getThumbs = function getSubs(url, options, callback) {
    'use strict';
    if (typeof options === 'function') {
        callback = options;
        options = {};
    }

    var args = ['--skip-download'];

    if (options.all) {
        args.push('--write-all-thumbnails');
    } else {
        args.push('--write-thumbnail');
    }

    if (!options.warrning) {
        args.push('--no-warnings');
    }

    call(url, args, [], { cwd: options.cwd }, function(err, data) {
        if (err) { return callback(err); }

        var files = [];
        for (var i = 0, len = data.length; i < len; i++) {
            var line = data[i];
            var info = 'Writing thumbnail to: ';
            if (line.indexOf(info) !== -1) {
                files.push(line.slice(line.indexOf(info) + info.length));
            }
        }
        callback(null, files);
    });
};

/**
 * @param {!Boolean} descriptions
 * @param {!Object} options
 * @param {Function(!Error, Object)} callback
 */
ytdl.getExtractors = function getExtractors(descriptions, options, callback) {
    'use strict';
    if (typeof options === 'function') {
        callback = options;
        options = {};
    } else if (typeof descriptions === 'function') {
        callback = descriptions;
        options = {};
        descriptions = false;
    }

    var args = descriptions ? ['--extractor-descriptions'] : ['--list-extractors'];
    call(null, args, null, options, callback);
};