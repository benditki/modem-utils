const serialport = require('serialport')
const Ractive = require('ractive')
const GSM = require('./gsm.js')
var gsm = new GSM(log)

localStorage.debug = "=D="

function $(id) { return document.getElementById(id) }

var sections = [
    { name: 'modem',        icon: '&#xe61e;' },
    { name: 'cloud',        icon: '&#xe66a;' },
    { name: 'certificates', icon: '&#xe62e;' }
]


var ractive = new Ractive({
    el: 'container',
    template: '#header-tpl',
    data: {
        sections,
        active_section: 'modem',
        show_grid: false
    }
});

ractive.on({
    connect,
    disconnect,
    scan_ports
})
scan_ports()

function scan_ports() {

    serialport.list((err, ports) => {
        console.log('scanned ports', ports)
        ractive.set("scan_error", err)
        ractive.set("ports", ports)
    })
}

async function disconnect(context) {
    try {
        await gsm.disconnect()
        ractive.set('connected_port', null)
    }
    catch (e) {
        log("ERROR: " + e.message)
    }
}

async function connect(context, port_name) {
    try {
        ractive.set('connecting', true)
        await gsm.connect(port_name, 115200)
        ractive.set('connected_port', port_name)
        await gsm.AT()
        ractive.set('connecting', false)
        
        return get_info(context)
    }
    catch (e) {
        log("ERROR: " + e.message)
        await gsm.disconnect()
        ractive.set('connected_port', null)
        ractive.set('connecting', false)
    }
}

async function get_info(context) {
    try {
        var response = await gsm.command("ATI")
        ractive.set("modem.model", response.body)
        response = await gsm.command("AT+GSN")
        ractive.set("modem.sn", response.body)
        response = await gsm.command("AT+CCID")
        ractive.set("sim.id", response.sim_id)
        response = await gsm.command("AT+UCGOPS?")
        ractive.set("operator", response.operator)
        ractive.set("network", response.network)
    }
    catch (e) {
        log("ERROR: " + e.message)
    }       
}

function log(msg) {
    var p = document.createElement("p")
    p.innerText = msg
    if (msg.startsWith('> ')) {
        p.classList.add('sent')
    } else if (msg.startsWith('< ')) {
        p.classList.add('received')
    } else if (msg.startsWith('ERROR: ')) {
        p.classList.add('error')
    }
    var elem = $('log')
    elem.appendChild(p)
    elem.scrollTop = elem.scrollHeight
}
