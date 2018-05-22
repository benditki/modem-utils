// This file is required by the index.html file and will
// be executed in the renderer process for that window.
// All of the Node.js APIs are available in this process.

const serialport = require('serialport')
const GSM = require('./gsm.js')
var gsm = new GSM(log)

localStorage.debug = "=D="

function scan_ports() {

    serialport.list((err, ports) => {
        console.log('scanned ports', ports)
        if (err) {
            document.getElementById('error').textContent = err.message
            return
        } else {
            document.getElementById('error').textContent = ''
        }

        if (ports.length === 0) {
            document.getElementById('error').textContent = 'No ports discovered'
            return
        }
        
        var elem = document.getElementById("ports")
        while (elem.options.length > 0) {                
            elem.remove(0);
        }   
        ports.forEach( port => {
            var option = document.createElement("option")
            option.value = port.comName
            option.text = port.comName + ": " + port.manufacturer + (port.serialNumber ? "-" + port.serialNumber : "")
            elem.add(option)
        } )

    })
}

async function connect() {
    try {
        var elem = document.getElementById("ports")
        var port = elem.options[elem.selectedIndex].value;
        
        await gsm.connect(port, 115200);
        await gsm.AT()
    }
    catch (e) {
        log("ERROR: " + e.message)
    }
}

function log(msg) {
    var p = document.createElement("p")
    p.innerText = msg
    var elem = document.getElementById('log')
    elem.appendChild(p)
    elem.scrollTop = elem.scrollHeight
}
    

scan_ports()
document.getElementById('scan').addEventListener("click", scan_ports)
document.getElementById('connect').addEventListener("click", connect)