const SerialPort = require('serialport');
const RegexParser = require('parser-regex');
const jsesc = require('jsesc');
const program = require('commander');
const fs = require('fs');

class NoResponseError extends Error {
    constructor(cmd) {
        super(`no response on ${cmd}`);
        this.name = 'NoResponseError';
    }
}

class GSM {
	constructor(port, baudrate) {
		console.log("connecting to %s, baudrate=%d", port, baudrate);
		this.port = new SerialPort(port, { baudRate: baudrate });

		this.port.on('error', function(err) {
		  console.log('Error: ', err.message);
		})

		this.parser = this.port.pipe(new RegexParser({ regex: /[\r\n]+/ }));
		
		this.silence_timeout = 20;
		
	}
	
	async command(cmd, timeout = 10000, repeat = 0) {
		
		var response;
		var counter = 0;
		while (!response && (repeat == 0 || counter < repeat)) {
			try {
				var gsm = this;
				var silence_timeout_id;
				var on_data;
				var response = { cmd: cmd };
				var promise = new Promise( (resolve, reject) => {
					gsm.parser.on('data', (data) => {
						console.log("< %s", jsesc(data));
						parse_response(data, response);
						if (silence_timeout_id) {
							clearTimeout(silence_timeout_id);
						}
						silence_timeout_id = setTimeout(() => resolve(response), gsm.silence_timeout);
					});
					setTimeout(() => reject(new NoResponseError(cmd)), timeout);
				});
				
				console.log("> %s", jsesc(cmd));
				gsm.port.write(cmd + "\r");
				await gsm.port.drain();
				counter++;
				console.log("waiting for response (%d tries)", counter);
				response = await promise;
				
				console.log("response:", response);
			}
			catch (e) {
				if (!(e instanceof NoResponseError)) {
					throw e;
				}
			}
			gsm.parser.removeAllListeners('data');
		}
		return response;	
	}
	
	AT() { return this.command("AT", 2000); }
	
	async loadCert(filename) {
		var data = fs.readFileSync(filename);
		return this.command(`AT+USECMNG=0,0,"testCA",${data.length}`);
	}
	
	async writeFile(filename, data) {
		return this.command(`AT+UDWNFILE="${filename}",${data.length}`, 10000, 1);
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
	var gsm = new GSM(port, +baudrate || 115200);
	await gsm.AT();
	await gsm.AT();
	//await gsm.loadCert("/work/cert/ME8_PO00000008_Batch0001/3c8012db-0e00-4745-af0d-0ed7ff4cdcde/car_Cert.crt");
	await gsm.command("ATI");
	await gsm.writeFile("test_file", "test content");
}



