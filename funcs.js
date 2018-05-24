function $(id) { return document.getElementById(id) }

function deactivate(elem) {
    if (elem) elem.classList.remove('active');
}

function activate(elem) {
    if (elem) elem.classList.add('active');
}

function show(id) {
    var elem = document.querySelector(`[onclick="show('${id}')"]:not(.active)`);
    if (elem) {
        document.querySelectorAll("nav .active, main section.active").forEach(deactivate);
        activate(elem);
        activate(document.querySelector(`#${id}`));
    }
}
