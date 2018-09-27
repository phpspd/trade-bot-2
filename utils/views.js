let fs = require('fs'),
    path = require('path'),
    mustache = require('mustache');

let getView = function (path) {
    return fs.readFileSync(path, 'utf8');
}

module.exports = function (ctrlName) {
    let methods = {};

    methods.getHeader = function (data) {
        let viewPath = path.join(__dirname, '../views/header.tpl.html');
        return mustache.render(getView(viewPath), data);
    }

    methods.getFooter = function () {
        return getView(path.join(__dirname, '../views/footer.tpl.html'));
    }

    methods.getMenu = function (viewName, data) {
        return '';
    }

    methods.render = function (viewName, data, partials) {
        if (partials) {
            for (let key in partials) {
                let tplPath = partials[key];
                if (fs.existsSync(path.join(__dirname, '..', tplPath))) {
                    partials[key] = getView(tplPath);
                }
            }
        }
        return mustache.render(getView(path.join(__dirname, '../views', ctrlName, viewName) + '.tpl.html'), data, partials);

        //return false;
    }

    return methods;
}