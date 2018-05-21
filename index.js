const SerialPort = require('serialport');
const program = require('commander');
const fs = require('fs');
const GSM = require('./gsm.js');

program.version("1.0.0");
program.command("list").description("list all ports").action(list_ports);
program.command("check").description("check certificate").arguments("<type> <filename> <port> [baudrate]").action(check_cert)
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

async function check_cert(type, filename, port, baudrate) {
	var gsm = new GSM();
    try {
		var data = fs.readFileSync(filename).toString('binary');

        await gsm.connect(port, +baudrate || 115200);
	    await gsm.AT();
		await gsm.command("AT+CMEE=2");
		var result = await gsm.loadCert(type, data);
		if (result.code == 0) {
			console.log("The certificate is OK");
		} else {
			console.log("Invalid certificate");
		}
    } catch (e) {
        console.log("ERROR:", e.message);
    }
	process.exit();
}



