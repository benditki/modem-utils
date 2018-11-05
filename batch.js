const serialport = require('serialport')
const fs = require('fs')
const Ractive = require('ractive')
const GSM = require('./gsm.js')
const util = require('util')

gsms = {}

const scan_ports = util.promisify(serialport.list)

localStorage.debug = "" //"=D="

function $(id) { return document.getElementById(id) }

var ractive = new Ractive({
    el: 'body',
    template: '#page-tpl',
    data: {
        show_grid: false,
        state_class(gsm) {
            if (gsm.done) {
                return 'done'
            }
            if (gsm.state >= 1) return 'wip'
        }
    },
    carousel() { return `<div class="dot-carousel"></div>` },
    waiting: (label) => { return `
        <i class="la-line-scale-pulse-out-rapid la-dark la-sm"><div></div><div></div><div></div><div></div><div></div></i>
        <span class="progress">${label}</span>
        <i class="la-line-scale-pulse-out-rapid la-dark la-sm"><div></div><div></div><div></div><div></div><div></div></i>`
    }
});

var baudrate_map = {}

try {
    baudrate_map = JSON.parse(localStorage.baudrate_map)
}
catch (e) {
    if (!e instanceof SyntaxError) {
        throw e
    }
}

window.onbeforeunload = function () {
    localStorage.baudrate_map = JSON.stringify(baudrate_map)
}
window.ractive = ractive




function log(msg) {
    /*
    var p = document.createElement("p")
    p.innerText = msg
    if (msg.startsWith('ERROR: ') || msg.startsWith('< +CME ERROR:')){
        p.classList.add('error')
    } else if (msg.startsWith('< ')) {
        p.classList.add('received')
    } else if (msg.startsWith('> ')) {
        p.classList.add('sent')
    }
    var elem = $('log')
    elem.appendChild(p)
    elem.scrollTop = elem.scrollHeight
    */
}

var desired_baudrate = 921600

function make_first(first, list) {
    var res = [first]
    for (var item of list) {
        if (item != first) {
            res.push(item)
        }
    }
    return res
}

async function connect(port_name) {
    var baudrates = [115200, 921600]
    if (baudrate_map[port_name]) {
        baudrates = make_first(baudrate_map[port_name], baudrates)
    }
    var key = "gsm." + port_name + "."
    var gsm = gsms[port_name]
    try {
        await ractive.set(key + "done", false)
        await ractive.set(key + "state", 0)
        baudrate = await gsm.connect(port_name, baudrates)
        
        await ractive.set(key + "active_baudrate", baudrate)
        await ractive.set(key + "state", 1)

        if (baudrate != desired_baudrate) {
            await gsm.command(`AT+IPR=${desired_baudrate}`)
            baudrate = await gsm.connect(port_name, make_first(desired_baudrate, baudrates))
            await gsm.command("AT&W")
            await gsm.restart()
        }
        
        baudrate_map[port_name] = baudrate
        
        await ractive.set(key + "active_baudrate", baudrate)
        await ractive.set(key + "state", 2)
        
        var response;
        response = await gsm.command("ATI")
        await ractive.set(key + "model", response.body)
        response = await gsm.command("AT+GSN")
        await ractive.set(key + "sn", response.body)
        await ractive.set(key + "state", 3)
        
        response = await gsm.command("AT+UPSND=0,8")
        var gprs_activated = response.status == "1"
        if (!gprs_activated) {
            await gsm.command("AT+UPSDA=0,2")
        }

        response = await gsm.command("AT+UPSD=0,1;+UPSD=0,7;&V")
        console.log(response)
        if (response.apn != "mobileye8" || response.stored_ip != "0.0.0.0" ||
                response.flow_control != "0" || response.echo != "0" || response.verbose != "0") {
            if (gprs_activated) {
                await gsm.command("AT+UPSDA=0,4")
            }
            await gsm.command("ATE0;V0;&K0;&W;+UPSD=0,1,\"mobileye8\";+UPSD=0,7,\"0.0.0.0\";+UPSDA=0,1")
            await gsm.restart()
            await gsm.command("AT+UPSDA=0,2")
            response = await gsm.command("AT+UPSD=0,1;+UPSD=0,7")
        }
            
        await ractive.set(key + "apn", response.apn)
        await ractive.set(key + "static_ip", response.stored_ip)

        response = await gsm.CCID()
        await ractive.set(key + "sim_id", response.sim_id)
        await ractive.set(key + "state", 4)
        if (response.sim_id) {
            await ractive.set(key + "state", 5)
            response = await gsm.command("AT+UCGOPS?;+CGATT?", {
                response_valid: response => response && response.operator && response.network && response.gprs_attached == "1",
                timeout: 2000
            })
            await ractive.set("operator", response.operator)
            await ractive.set("network", response.network)
            await ractive.set("gprs_attached", response.gprs_attached == "1")
            await ractive.set(key + "state", 6)

            response = await gsm.command("AT+UPSND=0,8")
            if (response.status == "0") {
                await gsm.command("AT+UPSDA=0,3")
            }

            response = await gsm.command("AT+UPSND=0,0")
            await ractive.set("current_ip", response.ip)
            await ractive.set(key + "state", 7)
        }
        
        await ractive.set(key + "done", true)
            
        setTimeout(check, 200, port_name)
    }
    catch (e) {
        log("ERROR: " + e.message)
        disconnect(port_name)
    }
}

async function disconnect(port_name) {
    await gsms[port_name].disconnect()
    delete gsms[port_name]
}

async function check(port_name) {
    if (!gsms[port_name]) return;
    try {
        await gsms[port_name].command("AT", {timeout: 200, repeat: 1})
        setTimeout(check, 400, port_name)
    } catch (e) {
        log("ERROR: " + e.message)
        await disconnect(port_name)
    }
}

async function refresh_ports() {
    var exclude_ports = ["COM1"]
    var ports = await scan_ports()

    var port_names = [];
    for (port of ports) {
        if (exclude_ports.includes(port.comName)) continue;
        port_names.push(port.comName)
    }

    for (var port_name of port_names) {
        if (!gsms[port_name]) {
            var gsm = new GSM(log)
            gsms[port_name] = gsm
            connect(port_name)
        }
    }
    
    for (var port_name in gsms) {
        if (gsms[port_name]) {
            if (!port_names.includes(port_name)) {
                await disconnect(port_name)
                delete ractive.get('gsm')[port_name]
                await ractive.update('gsm.' + port_name)
            }
        }
    }
}

setInterval(refresh_ports, 200)
