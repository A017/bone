var _ = require('lodash');
var path = require('path');
var fs = require('fs');
var FileSystem = require('./fs.js');
var bonefs = FileSystem.fs;
var aggre = require('akostream').aggre;
var cache = require('./cache.js');
var Data = require('./data.js');
var through = require('through2');
var Plugins = require('./plugins.js');

function ReadStream(file, option, acts) {
    option || (option = {});
    option.quote || (option.quote = {});
    // 对真实文件的依赖
    this.dependentFile = null;
    // 文件完整路径
    this.path = file;
    // 文件夹
    this.dir = path.dirname(file);
    // 文件名
    this.basename = path.basename(file);
    // 是否虚拟文件
    this.isVirtual = bonefs.existFile(file, {
        notFs: true
    });
    // 来源文件
    this.source = null;
    // 依赖的真实文件, resolveDependentFile之后可以获取
    this.originSource = null;
    // 文件源流
    this.sourceStream = null;
    // 读取流参数
    this.option = option;
    // 依赖文件堆栈
    this.trackStack = [];
    // 附加act
    this.acts = !acts ? [] : (_.isArray(acts) ? acts : [acts]);
    // 附加act依赖的文件
    this.actsDependent = [];
    this.onEnd = option.onEnd;
    // 源文件流
    this._sourceStream = null;
    // 解析文件链
    this._checkOverReferences();
    this._resolve();
    // _resolveDependentFile(this);
}

ReadStream.prototype._checkOverReferences = function() {
    var option = this.option;

    if (this.path in option.quote) {
        if (this.isVirtual) {
            bone.log.error('File over references: ' + this.path + '!');
        }
    } else {
        option.quote[this.path] = true;
    }
};

ReadStream.prototype._resolve = function() {
    this.trackStack.push(this.path);

    if (!this.isVirtual) {
        this.source = this.path;
        this.originSource = this.path;
    } else {
        this.source = Data.virtualFiles[this.path].src;
        this._sourceStream = new ReadStream(Data.virtualFiles[this.path].src, this.option);
        this.originSource = this._sourceStream.originSource;
        this.trackStack = this.trackStack.concat(this._sourceStream.trackStack);
    }
};

ReadStream.prototype._read = function() {
    var originStream;
    var readStream = this;
    if (cache.cached(this.path)) {
        originStream = bone.utils.stream.origin(cache.get(this.path));
    } else {
        if (this._sourceStream) {
            originStream = this._sourceStream.getStream();
        } else {
            originStream = bone.utils.stream.origin(fs.readFileSync(this.path));
        }
    }

    // transform to obj stream.
    var objStream = through.obj(function(buffer, encoding, callback) {
        var data = {
            buffer: buffer,
            source: readStream.originSource,
            sourceParsed: path.parse(readStream.originSource),
            destination: readStream.path,
            destinationParsed: path.parse(readStream.path),
            cacheable: true,
            dependency: [readStream.source],
            fs: FileSystem.getFs({
                captureFile: true,
                globalAct: readStream.isVirtual ? Data.virtualFiles[readStream.path].globalActs : []
            })
        };
        callback(null, data);
    });

    this._readStream = originStream.pipe(objStream);
    if (!cache.cached(this.path)) {
        this._handlerAct();
    }
};

ReadStream.prototype._processAct = function(act, gloabl) {
    var readStream = this;
    // fix issue https://github.com/wyicwx/bone/issues/2
    if (!(act instanceof Plugins.Plugins)) {
        act = act();
    }

    if (!(act instanceof Plugins.Plugins)) {
        return;
    }

    if(gloabl && !act.globalEnable()) {
        bone.log.warn('The plugin "' + act.name + '" fobidden to use in gloabl!');
        return;
    }

    var targetStream = act.getThroughStream();
    targetStream.on('error', function(error) {
        readStream._readStream.emit('error', error);
    });
    this._readStream = this._readStream.pipe(targetStream);
};

ReadStream.prototype._handlerAct = function() {
    var readStream = this;

    if (this.isVirtual) {
        var acts = Data.virtualFiles[this.path].acts;
        _.each(acts, function(act) {
            this._processAct(act);
        }, this);
    }

    var collectStream = through.obj(function(data, encoding, callback) {
        if (data.cacheable) {
            cache.set(readStream.path, data.buffer);
        }
        if (readStream.isVirtual) {
            var dependency = data.dependency.concat(data.fs._readFiles);
            dependency = _.uniq(dependency);
            FileSystem.setTraceTree(readStream.path, dependency);
            // 清空插件所依赖的文件，防止和全局插件依赖文件混在一起
            data.fs._readFiles.length = 0;
        } else {
            FileSystem.event.emit('readFile', readStream.path);
        }

        callback(null, data);
    });

    this._readStream = this._readStream.pipe(collectStream);
};

ReadStream.prototype._handlerGlobalAct = function() {
    var readStream = this;

    _.each(this.acts, function(act) {
        this._processAct(act, true);
    }, this);

    var collectStream = through.obj(function(data, encoding, callback) {
        readStream.actsDependent = readStream.actsDependent.concat(data.fs._readFiles);
        callback(null, data);
    });

    this._readStream = this._readStream.pipe(collectStream);    
};

ReadStream.prototype._end = function() {
    var readStream = this;
    this._handlerGlobalAct();

    var endStream = through.obj(function(data, encoding, callback) {
        if(readStream.onEnd) {
            readStream.onEnd();
        }
        callback(null, data.buffer);
    });
    this._readStream = this._readStream.pipe(endStream);
};

ReadStream.prototype.getStream = function() {
    this._read();
    this._end();

    return this._readStream;
};

module.exports = ReadStream;