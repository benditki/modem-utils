require('promise.prototype.finally').shim();
require('colors');
const debug = require('debug')('=D=');
const SerialPort = require('serialport');
const { Transform } = require('stream');
const jsesc = require('jsesc');
const program = require('commander');
const fs = require('fs');

class NoResponseError extends Error {
    constructor(cmd) {
        super(`no response on ${cmd}`);
        this.name = 'NoResponseError';
    }
}

class ModemParser extends Transform {
    constructor (opts) {
        opts = Object.assign({}, opts, { readableObjectMode: true });
        super(opts);
        this.data = '';
    }
    
    _transform (chunk, encoding, cb) {
        debug("got", jsesc(chunk.toString('binary')));
        this.data += chunk.toString("binary");
        var tests = [
            [/^\n?(>)/, "prompt"],
			[/^\+CME ERROR: (.*)[\r\n]+/, "error"],
            [/^([0-9])[\r\n]*/, "code"],
			[/^(.+?)[\r\n]+/, "body"]
        ];
		var parsing = true;
		while (this.data.length && parsing) {
			parsing = false;
			for (var test of tests) {
				debug("parsing", jsesc(this.data), "with", test[0]);
				var res = this.data.match(test[0]);
				if (res) {
					parsing = true;
					console.log("< %s".bold.green, jsesc(res[0]).bold.green);
					var response = {}
					for (var i = 1; i < test.length; i++) {
						response[test[i]] = res[i];
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
        this.push(this.data);
        this.data = '';
        setImmediate(cb);
    }
}

function has (key) {
    return obj => obj && typeof obj[key] !== 'undefined';
}


class GSM {
	constructor() {
		this.silence_timeout = 20;
	}
    
    async connect(path, baudrate) {
		debug("connecting to %s, baudrate=%d", path, baudrate);
		var port = new SerialPort(path, { baudRate: baudrate, autoOpen: false });
        this.port = port;

        return new Promise((resolve, reject) =>{
            port.open(reject);
            port.on('open', resolve);
		});
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
                
				console.log("> %s".bold.yellow, jsesc(cmd + "\r").bold.yellow);
				this.port.write(cmd + "\r");
				await this.port.drain();
				counter++;
				debug("waiting for response (%d tries)", counter);
				response = await promise;
				
				debug("response:", response, "valid:", response_valid(response));
			}
			catch (e) {
				if (!(e instanceof NoResponseError)) {
					throw e;
				}
			}
		}
		return response;	
	}
	
    receiveResponse(cmd, response_valid, timeout) {
        var silence_timeout = this.silense_timeout;
        var silence_timeout_id;
        var parser = new ModemParser();
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
        console.log("> %s".bold.yellow, jsesc(data).bold.yellow);
        return this.port.drain();
    }

	AT() { return this.command("AT", { timeout: 2000 }); }
	
	async loadCert(type, filename) {
		var label = "test";
		var data = fs.readFileSync(filename).toString('binary');
		await this.command(`AT+USECMNG=0,${type},"${label}",${data.length}`, { response_valid: response => response && response.prompt == '>' });
		await this.sendData(data);
		return this.receiveResponse("cert", has('code'), 10000);
	}
	
	async writeFile(filename, data) {
		await this.command(`AT+UDWNFILE="${filename}",${data.length}`, { response_valid: response => response && response.prompt == '>' });
        await this.sendData(data);
        return this.receiveResponse("data", has('code'), 10000);
	}
}

function parse_response(data, response) {
	if (!isNaN(data) && data >= 0 && data <= 9) {
		return Object.assign(response, { code: +data });
	}
	return Object.assign(response, { body: data });
}


program.version("1.0.0");
program.command("list").description("list all ports").action(list_ports);
program.command("*").arguments("<type> <filename> <port> [baudrate]").action(main)
program.parse(process.argv);

async function list_ports() {
	var ports = await SerialPort.list();
	for (var port of ports) {
		var desc = "";
		if (port.manufacturer) {
			desc += port.manufacturer
		}
		if (port.serialNumber) {
			if (desc) {
				desc += ", ";
			}
			desc += port.serialNumber;
		}
		if (desc) {
			console.log("%s - %s", port.comName, desc);
		} else {
			console.log(port.comName);
		}
	}
}

async function main(type, filename, port, baudrate) {
	var gsm = new GSM();
    try {
        await gsm.connect(port, +baudrate || 115200);
	    await gsm.AT();
		await gsm.command("AT+CMEE=2");
		await gsm.loadCert(type, filename);
        console.log("Finished");
    } catch (e) {
        console.log(e);
    }
	process.exit();
}



