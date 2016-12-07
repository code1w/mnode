/**
 * Created by zhengjinwei on 2016/12/4.
 */
var Http = require("http");
var Https = require("https");
var Fs = require("fs");
var Url = require('url');
var IpUtils = require("../../utils/ip-utils/app");
var Qs = require('querystring');
var Logger = require('pomelo-logger').getLogger('Http', __filename, process.pid);
var FileUtils = require("../../utils/app").File;
var Path = require("path");
var EventEmitter = require("events").EventEmitter;
var Util = require("util");
var _ = require("lodash");
var Protocol = require("./protocol");
var Encrypt = require("../../utils/app").Encrypt;


function HttpServer(bindPort, bindHost, opts, serverRootPath) {
    EventEmitter.call(this);

    this.host = bindHost;
    this.port = bindPort;

    if (!FileUtils.isDirectory(serverRootPath)) {
        throw new Error(serverRootPath + " must be a valid directory");
    }
    //服务运行目录
    this.runPath = serverRootPath;

    if (!this.host) {
        this.host = "127.0.0.1";
    }
    if (!this.port) {
        this.port = 8182;
    }
    this.opts = {
        key: null,
        ca: [],
        cert: null,
        protocols: ""
    };

    this.methods = ["get", "post"];


    if (opts) {
        if (typeof opts !== "object") {
            throw new Error(opts + " must be object");
        }
        if (!opts['key'] || !opts["cert"]) {
            throw new Error(opts + " invalid parameters");
        }
        this.opts.key = Fs.readFileSync(opts.key);
        this.opts.cert = Fs.readFileSync(opts.cert);
        if (opts['ca']) {
            this.opts.ca.push(Fs.readFileSync(opts.ca))
        }
        if (opts['protocols'] && _.isString(opts['protocols'])) {
            this.opts.protocols = opts['protocols'];
        }
    }

    //创建文件夹 /get  /post
    FileUtils.createDirectory(Path.resolve(this.runPath + "/" + "get"));
    FileUtils.createDirectory(Path.resolve(this.runPath + "/" + "post"));

    var template = FileUtils.readSync(Path.resolve(Path.join(__dirname, "/template.js")));

    var _file1 = Path.resolve(this.runPath + "/" + "post" + "/helloword.js");
    if (!FileUtils.isExists(_file1)) {
        FileUtils.writeSync(_file1, template);
    }

    var _file2 = Path.resolve(this.runPath + "/" + "get" + "/helloword.js");
    if (!FileUtils.isExists(_file2)) {
        FileUtils.writeSync(_file2, template);
    }

    //路由缓存
    this.routes = {
        "get": [],
        "post": []
    };
    var routeGetList = FileUtils.traverseSync(Path.resolve(this.runPath + "/" + "get"), 2);
    var routePostList = FileUtils.traverseSync(Path.resolve(this.runPath + "/" + "post"), 2);

    var self = this;
    routeGetList.forEach(function (route) {
        var _path = Path.resolve(route.path);
        self.routes.get[route.rawName] = require(_path);
    });

    routePostList.forEach(function (route) {
        var _path = Path.resolve(route.path);
        self.routes.post[route.rawName] = require(_path);
    });

    //监听器
    this.listener = null;


    //回话 保活列表
    this.skey = "asklapoposa";
    this.sessions = {};
}

Util.inherits(HttpServer, EventEmitter);


HttpServer.prototype.create = function (callback) {
    if (this.opts.key) {
        this.listener = Https.createServer(this.opts, function (req, res) {
            callback(req, res);
        }).listen(this.port, this.host);
    } else {
        this.listener = Http.createServer(function (req, res) {
            callback(req, res);
        }).listen(this.port, this.host);
    }

    Logger.info("http server already listen on port:", this.port);
};

HttpServer.prototype.createServer = function () {
    var self = this;
    this.create(function (request, response) {

        var bytes = [];
        request.on('data', function (chunk) {
            bytes.push(chunk);
        });
        request.on('end', function () {
            var buf = Buffer.concat(bytes);
            self.protocolProcess(buf, self.opts.protocols || "", function (err, data) {
                if (err) {
                    Logger.error("Protocol format error!");
                } else {
                    var message = processRequest(request);
                    var e = null;
                    try {
                        if (self.methods.indexOf(message.method.toLowerCase()) == -1) {
                            Logger.error("does not support ", message.method, " method");
                            e = {msg: Util.format("server does not support %s request method", message.method)};
                        }
                    } catch (exception) {
                        Logger.error("Got Exception:", exception.message);
                        e = exception;
                    } finally {
                        if (e) {
                            response.statusCode = 500;
                            response.end(Util.format("error:%s", e.message));
                        } else {
                            self.processMessage(message, response);
                        }
                    }
                }
            });
        });
    });
};
HttpServer.prototype.protocolProcess = function (buff, protocol, callback) {
    Protocol.decode(buff, protocol, function (err, resp) {
        callback(err, resp);
    })
};
HttpServer.prototype.getReqModule = function (route) {
    if (route.indexOf("/") == -1) {
        return {
            "module": route,
            "func": "index"
        };
    }
    var _list = route.split("/");
    return {
        "module": _list[0],
        "func": _list[1]
    };
};


HttpServer.prototype.processMessage = function (message, response) {
    var _routeName = message.method.toLowerCase();

    var _routesList = null;
    if (_routeName === "get") {
        _routesList = this.routes.get;
    } else if (_routeName === "post") {
        _routesList = this.routes.post;
    }

    if (_routesList != null) {
        var route = message.route;

        var _module = this.getReqModule(route);

        if (_routesList[_module.module] == undefined) {
            response.statusCode = 404;
            response.end("未知路由");
            return;
        }

        if (_routesList[_module.module][_module.func] == undefined) {
            response.statusCode = 404;
            response.end("未知路由");
            return;
        }

        _routesList[_module.module][_module.func](message, response);
    } else {
        response.statusCode = 501;
        response.end("un support the method");
    }
};

var processRequest = function (request) {
    var url = Url.parse(request.url);
    return {
        httpVersion: request.httpVersion,
        route: url.pathname.slice(1, url.pathname.length),
        params: Qs.parse(url.query),
        method: request.method,
        statusCode: request.statusCode,
        headers: request.headers,
        remoteAddress: IpUtils.getClientIP(request)
    };
};


module.exports = HttpServer;