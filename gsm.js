require('promise.prototype.finally').shim();
require('colors');
const debug = require('debug')('=D=');
const SerialPort = require('serialport');
const { Transform } = require('stream');
const jsesc = require('jsesc');
const { promisify } = require('util');

class NoResponseError extends Error {
    constructor(cmd) {
        super(`no response on ${cmd} command`);
        this.name = 'NoResponseError';
    }
}

function parse_network(num) {
    switch (num) {
        case "0": return { network: "GSM" }
        case "1": return { network: "GSM COMPACT" }
        case "2": return { network: "UTRAN (UMTS)" }
        case "3": return { network: "GSM with EDGE availability" }
        case "4": return { network: "UTRAN with HSDPA availability" }
        case "5": return { network: "UTRAN with HSUPA availability" }
        case "6": return { network: "UTRAN with HSDPA and HSUPA availability" }
        case "7": return { network: "LTE" }
    }
}

function parse_error_class(num) {
    var classes = {
        "3": "HTTP Error"
    }
    return { error_class: classes[num] || `Internet suite error CLASS${num}` }
}

function parse_error_code(num) {
    var codes = {
        "11": "Server connection error"
    }
    return { error_code: codes[num] || `Error ${num}` }
}


function parse_file_read(data) {
    var re = /^(\r\n\+URDFILE: ".*"),(\d+),([^]*)/
    debug("parsing", jsesc(data), "with", re);
    var res = data.match(re)
    if (res && res[3].length >= (+res[2]) + 2 &&
        res[3][0] == '"' && res[3][(+res[2])+1] == '"') {

        var res_length = res[1].length + res[2].length + (+res[2]) + 4
        return [data.slice(0, res_length), res[3].slice(1, +res[2])]
    }
}


class ModemParser extends Transform {
    constructor (opts) {
        opts = Object.assign({}, opts, { readableObjectMode: true })
        super(opts)
        this.log = opts.log
        this.data = ''
    }

    _transform (chunk, encoding, cb) {
        debug("got", jsesc(chunk.toString('binary')));
        this.data += chunk.toString("binary");
        var tests = [
            [/^\n?(>)/, "prompt"],
            [/^\+CME ERROR: (.*)[\r\n]+/, "error"],
            [/^\+CCID: (\d+)\r\n/, "sim_id"],
            [/^\+UCGOPS: (\d+),(\d+),(".*"),(\d+)\r\n/, "status", "format", "operator", parse_network],
            [/^\+USECMNG: \d+,\d+,".*","(.*)"\r\n/, "md5"],
            [/^\+UPSND: 0,8,(\d+)\r\n/, "status"],
            [/^\+UUHTTPCR: 0,\d+,(\d+)\r/, "http_result"],
            [parse_file_read, "content"],
            [/^\+UHTTPER: \d+,(\d+),(\d+)\r\n/, parse_error_class, parse_error_code],
            [/^\+UPSD: 0,1,"(.*)"\r\n/, "apn"],
            [/^\+UPSD: 0,7,"(.*)"\r\n/, "stored_ip"],
            [/^\+UPSND: 0,0,"(.*)"\r\n/, "ip"],
            [/^\+CGATT: (\d+)\r\n/, "gprs_attached"],
            [/^([0-9])\r/, "code"],
            [/^(.+?)[\r\n]+/, "body"]
        ];
        var parsing = true;
        while (this.data.length && parsing) {
            parsing = false;
            for (var test of tests) {
                var res;
                if (typeof test[0] == 'function') {
                    res = test[0](this.data)
                } else {
                    debug("parsing", jsesc(this.data), "with", test[0]);
                    res = this.data.match(test[0]);
                }
                if (res) {
                    parsing = true;
                    this.log("< " + jsesc(res[0]));
                    var response = {}
                    for (var i = 1; i < test.length; i++) {
                        debug("typeof test[i] ==", typeof test[i])
                        if (typeof test[i] == "function") {
                            Object.assign(response, test[i](res[i]))
                        } else {
                            response[test[i]] = res[i];
                        }
                    }
                    if (typeof response.error !== 'undefined') {
                        response.code = 4;
                    }
                    this.push(response);
                    this.data = this.data.slice(res[0].length);
                }
            }
        }
        setImmediate(cb);
    }

    _flush(cb) {
        this.log("< " + jsesc(this.data));
        this.push(this.data);
        this.data = '';
        setImmediate(cb);
    }
}

function has (key) {
    return obj => obj && typeof obj[key] !== 'undefined';
}

function equal (key, value) {
    return obj => obj && obj[key] == value;
}

function and (...funcs) {
    return obj => funcs.reduce((a, b) => a && b(obj), true)
}


class GSM {
    constructor(log) {
        this.log = log
        this.silence_timeout = 20
    }


    async disconnect () {
        if (this.port && this.port.isOpen) {
            debug("disconnecting from previous port");
            await promisify(this.port.close).call(this.port)
            this.log(`Disconnected from ${this.port.path}`)
            this.port = null
        }
    }

    async connect(path, baudrate) {
        await this.disconnect();
        debug("connecting to %s, baudrate=%d", path, baudrate);
        var port = new SerialPort(path, { baudRate: baudrate, autoOpen: false });
        this.port = port;

        return new Promise((resolve, reject) => {
            port.open(reject);
            port.on('open', resolve);
        }).then(() => { this.log(`Connected to ${path}, baudrate=${baudrate}`) } );
    }

    async command(cmd, opts) {

        opts = opts || {};
        var timeout = opts.timeout || 10000;
        var repeat = opts.repeat || 0;
        var response_valid = opts.response_valid || has('code');

        var response;
        var counter = 0;
        while (!response_valid(response) && (!repeat || counter < repeat)) {
            try {
                var promise = this.receiveResponse(cmd, response_valid, timeout);

                this.log("> " + jsesc(cmd + "\r"));
                this.port.write(cmd + "\r");
                await promisify(this.port.drain).call(this.port);
                counter++;
                debug("waiting for response (%d tries)", counter);
                response = await promise;

                debug("response:", response, "valid:", response_valid(response));
            }
            catch (e) {
                if (!(e instanceof NoResponseError) || repeat && counter >= repeat) {
                    throw e;
                }
            }
        }
        return response;
    }

    receiveResponse(cmd, response_valid, timeout) {
        var silence_timeout = this.silense_timeout;
        var silence_timeout_id;
        var parser = new ModemParser({log: this.log});
        var port = this.port;

        port.pipe(parser);
        var response = { cmd: cmd };
        var promise = new Promise( (resolve, reject) => {
            parser.on('data', (res) => {
                Object.assign(response, res);
                debug("res", res, "response", response);
                if (silence_timeout_id) {
                    clearTimeout(silence_timeout_id);
                }
                debug("response:", response, "validator:", response_valid, response, "valid:", response_valid(response));
                if (response_valid(response)) {
                    resolve(response);
                }
            });
            setTimeout(() => reject(new NoResponseError(cmd)), timeout);
        });
        return promise.finally(() => { debug("unpiping parser"); port.unpipe(parser); } )
    }

    async sendData(data) {
        this.port.write(data);
        this.log("> " + jsesc(data));
        return this.port.drain();
    }

    AT() { return this.command("AT", { timeout: 200, repeat: 5 }); }

    async loadCert(type, data, label) {
        label = label || "test";
        await this.command(`AT+USECMNG=0,${type},"${label}",${data.length}`, { response_valid: response => response && response.prompt == '>' });
        await this.sendData(data);
        return this.receiveResponse("cert", has('code'), 10000);
    }

    async writeFile(filename, data) {
        await this.command(`AT+UDWNFILE="${filename}",${data.length}`, { response_valid: response => response && response.prompt == '>' });
        await this.sendData(data);
        return this.receiveResponse("data", has('code'), 10000);
    }

    async http(method, url_str) {
        var url = new URL(url_str)
        var response = await this.command("AT+UPSND=0,8")
        if (response.status == "0") {
            await this.command("AT+UPSDA=0,2;+UPSD=0,1;+UPSD=0,7")
            response = await this.command("AT+UPSDA=0,3")
            if (response.code != "0") {
                throw Error("Can't activate GPRS profile. Possibly no data plan")
            }
        }
        var action = { GET: 1 }[method]
        var type = url.hostname.match(/^\d+.\d+.\d+.\d+/)? 0 : 1
        var path = url.pathname + url.search + url.hash
        var port = url.port || url.protocol == "https:" ? 443 : 80
        var modem_file = "http_res"
        response = await this.command(`AT+UHTTP=0;+UHTTP=0,${type},"${url.hostname}";+UHTTP=0,5,${port};+UHTTPC=0,${action},"${path}","${modem_file}"`,
            { timeout: 1 * 60 * 1000, response_valid: and(equal("code", "0"), has("http_result")) })

        if (response.http_result == "1") {
            return this.command(`AT+URDFILE="${modem_file}"`)
        } else {
            response = await this.command("AT+UHTTPER=0")
            response.http_error = `${response.error_class}: ${response.error_code}`
            return response
        }
    }
}


module.exports = GSM;



