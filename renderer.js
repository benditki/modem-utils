const serialport = require('serialport')
const fs = require('fs')
const Ractive = require('ractive')
const GSM = require('./gsm.js')
var gsm = new GSM(log)

localStorage.debug = "" //"=D="

function $(id) { return document.getElementById(id) }

var sections = [
    { name: 'modem',        icon: '&#xe61e;' },
    { name: 'cloud',        icon: '&#xe66a;' },
    { name: 'certificates', icon: '&#xe62e;' }
]

var FileElem = Ractive.extend({
    template: '#file-tpl',
    on: {
        update_path(context, name) {
            if (context.node.files.length) {
                context.set('value', context.node.files[0].path)
                var elem = context.node.form[name + "_path"]
                elem.scrollLeft = elem.scrollWidth
                this.fire('change')
                this.fire('select', context, context.get('value'))
            }
        }
    }
});

var CertElem = Ractive.extend({
    template: '#cert-tpl',
    components: {
        file: FileElem
    },
    async validate() {
        try {
            var data = fs.readFileSync(this.get('value')).toString('binary')
            var response = await gsm.loadCert(this.get('type'), data, this.get('name'))
            this.set("checked", true)
            console.log(response)
            if (response.code == "0") {
                this.set("valid", true)
                this.set("md5", response.md5)
            } else {
                this.set("valid", false)
            }
        }
        catch (e) {
            log("ERROR: " + e.message)
        }
    },
    on: {
        "file.select": async function () {
            if (!this.get('manual')) {
                this.validate()
            }
        },
        "change": function () {
            this.set("checked", false)
        }
    }
});


var ractive = new Ractive({
    el: 'container',
    template: '#header-tpl',
    components: {
        file: FileElem
        , cert: CertElem
    },
    data: {
        selected_port: localStorage.selected_port,
        sections,
        active_section: 'modem',
        show_grid: false,
        cert: {},
        url: "http://34.230.62.7"
    },

    waiting: (label) => { return `
        <i class="la-line-scale-pulse-out-rapid la-dark la-sm"><div></div><div></div><div></div><div></div><div></div></i>
        <span class="progress">${label}</span>
        <i class="la-line-scale-pulse-out-rapid la-dark la-sm"><div></div><div></div><div></div><div></div><div></div></i>`
    }
});

window.onbeforeunload = function () {
    localStorage.selected_port = ractive.get('selected_port')
}
window.ractive = ractive

ractive.on({
    connect,
    disconnect,
    scan_ports,
    validate_cert,
    update_cert_path,
    http
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
        await gsm.command("AT+CMEE=2")
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
        var response;
        ractive.set( { operator: null, network: null, gprs_attached: null } )
        response = await gsm.command("ATI;+GSN;+CCID")
        ractive.set("modem.model", response.body)
        ractive.set("modem.sn", response.body)
        ractive.set("sim.id", response.sim_id)

        response = await gsm.command("AT+UCGOPS?;+CGATT?", {
            response_valid: response => response && response.operator && response.network && response.gprs_attached == "1",
            timeout: 2000
        })
        ractive.set("operator", response.operator)
        ractive.set("network", response.network)
        ractive.set("gprs_attached", response.gprs_attached == "1")

        response = await gsm.command("AT+UPSND=0,8")
        if (response.status == "0") {
            ractive.set("current_ip", null)
            await gsm.command("AT+UPSDA=0,2")
        }

        response = await gsm.command("AT+UPSD=0,1;+UPSD=0,7")
        ractive.set("stored_apn", response.apn)
        ractive.set("current_apn", response.apn)
        ractive.set("stored_ip", response.stored_ip)

        response = await gsm.command("AT+UPSND=0,8")
        if (response.status == "0") {
            await gsm.command("AT+UPSDA=0,3")
        }

        response = await gsm.command("AT+UPSND=0,0")
        ractive.set("current_ip", response.ip)
    }
    catch (e) {
        log("ERROR: " + e.message)
    }
}

async function validate_cert(context) {
    try {
        var data = fs.readFileSync(context.get('path')).toString('binary')
        var response = await gsm.loadCert(context.get('type'), data)
        context.set(".checked", true)
        console.log(response)
        if (response.code == "0") {
            context.set("valid", true)
            context.set("md5", response.md5)
        } else {
            context.set("valid", false)
        }
    }
    catch (e) {
        log("ERROR: " + e.message)
    }
}

async function http(context, method, url) {
    try {
        context.set('http_error', null)
        context.set('http_response', null)
        context.set('sending', true)
        var response = await gsm.http(method, url)
        if (response.http_error) {
            context.set('http_error', response.http_error)
        } else {
            context.set('http_response', response.content)
        }
    }
    catch (e) {
        log("ERROR: " + e.message)
    }
    context.set('sending', false)
}

function log(msg) {
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
}


function update_cert_path(context) {
    if (context.node.files.length) {
        context.set('path', context.node.files[0].path)
        var elem = context.node.parentNode.file_path
        elem.scrollLeft = elem.scrollWidth
    }
}

