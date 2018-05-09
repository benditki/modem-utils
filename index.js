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
        debug("got", chunk);
        this.data += chunk.toString("binary");
        var tests = [
            [/^\n(>)/, "prompt"],
            [/^([0-9])[\r\n]*/, "code"]
        ];
        for (var test of tests) {
            var res = this.data.match(test[0]);
            if (res) {
                console.log("< %s".bold.green, jsesc(res[0]).bold.green);
                var response = {}
                for (var i = 1; i < test.length; i++) {
                    response[test[i]] = res[i];
                }
                this.push(response);
                this.data = this.data.slice(res[0].length);
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
				
				debug("response:", response);
			}
			catch (e) {
				if (!(e instanceof NoResponseError)) {
					throw e;
				}
			}
			//gsm.parser.removeAllListeners('data');
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
                if (response_valid) {
                    resolve(response);
                }
                silence_timeout_id = setTimeout(() => resolve(response), silence_timeout);
            });
            setTimeout(() => reject(new NoResponseError(cmd)), timeout);
        });
        return promise.finally(() => { port.unpipe(parser); } )
    }
    
    async sendData(data) {
        this.port.write(data);
        console.log("> %s".bold.yellow, jsesc(data).bold.yellow);
        return this.port.drain();
    }

	AT() { return this.command("AT", { timeout: 2000 }); }
	
	async loadCert(filename) {
		var data = fs.readFileSync(filename);
		return this.command(`AT+USECMNG=0,0,"testCA",${data.length}`);
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
program.command("*").arguments("<port> [baudrate]").action(main)
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

async function main(port, baudrate) {
	var gsm = new GSM();
    try {
        await gsm.connect(port, +baudrate || 115200);
	    await gsm.AT();
	    //await gsm.AT();
	    //await gsm.loadCert("/work/cert/ME8_PO00000008_Batch0001/3c8012db-0e00-4745-af0d-0ed7ff4cdcde/car_Cert.crt");
	    //await gsm.command("ATI");
	    await gsm.writeFile("test_file", "test content");
	    await gsm.AT();
        console.log("Finished");
        process.exit();
    } catch (e) {
        console.log(e);
    }
}



