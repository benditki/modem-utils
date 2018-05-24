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
            $('error').textContent = err.message
            return
        } else {
            $('error').textContent = ''
        }

        if (ports.length === 0) {
            $('error').textContent = 'No ports discovered'
            return
        }
        
        var elem = $("ports")
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
        var elem = $("ports")
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
    var elem = $('log')
    elem.appendChild(p)
    elem.scrollTop = elem.scrollHeight
}

function toggle_grid() {
    $('grid-toggle').classList.toggle('off')
    $('grid').classList.toggle('shown')
}
    

scan_ports()
$('scan').addEventListener("click", scan_ports)
$('connect').addEventListener("click", connect)

$('grid-toggle').addEventListener('click', toggle_grid)