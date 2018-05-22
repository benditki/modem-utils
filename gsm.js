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
                    this.log("< " + jsesc(res[0]));
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
	constructor(log) {
        this.log = log
		this.silence_timeout = 20
	}
    
    async connect(path, baudrate) {
        if (this.port && this.port.isOpen) {
            debug("disconnecting from previous port");
            await promisify(this.port.close).call(this.port)
            this.log(`Disconnected from ${this.port.path}`)
            this.port = null
        }
        
		debug("connecting to %s, baudrate=%d", path, baudrate);
		var port = new SerialPort(path, { baudRate: baudrate, autoOpen: false });
        this.port = port;

        return new Promise((resolve, reject) =>{
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
        console.log("> %s".bold.yellow, jsesc(data).bold.yellow);
        return this.port.drain();
    }

	AT() { return this.command("AT", { timeout: 500, repeat: 10 }); }
	
	async loadCert(type, data) {
		var label = "test";
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


module.exports = GSM;



