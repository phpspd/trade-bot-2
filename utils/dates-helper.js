let moment = require('moment');

module.exports.getCurrentDate = function(format) {
    let obj = moment();

    if (format == 'iso') {
        return obj.format('YYYY-MM-DD');
    }

    //ru
    return obj.format('DD.MM.YYYY');
}

module.exports.getCurrentDateTime = function(format) {
    let obj = moment();

    if (format == 'iso') {
        return obj.format('YYYY-MM-DD HH:mm');
    }

    //ru
    return obj.format('DD.MM.YYYY HH:mm');
}

module.exports.getDate = function(obj, format) {
    obj = moment(obj);
    
    if (format == 'iso') {
        return obj.format('YYYY-MM-DD');
    }

    //ru
    return obj.format('DD.MM.YYYY');
}

module.exports.getDateTime = function(obj, format) {
    obj = moment(obj);

    if (format == 'iso')
        return obj.format('YYYY-MM-DD HH:mm');

    return obj.format('DD.MM.YYYY HH:mm');
}

function parseDate(str, format) {
    if (format == 'iso') {
        result = moment(str);
    } else {
        result = moment(str, 'DD.MM.YYYY HH:mm:ss');
    }

    return new Date(result.toDate());
}

module.exports.parseDate = parseDate;

module.exports.convertDateTime = function(fromFormat, toFormat, date) {
    return module.exports.getDateTime(module.exports.parseDate(date, fromFormat), toFormat);
}

module.exports.convertDateTimeRu2Iso = module.exports.convertDateTime.bind(undefined, 'ru', 'iso');
module.exports.convertDateTimeIso2Ru = module.exports.convertDateTime.bind(undefined, 'iso', 'ru');


module.exports.convertDate = function(fromFormat, toFormat, date) {
    return module.exports.getDate(module.exports.parseDate(date, fromFormat), toFormat);
}

module.exports.convertDateRu2Iso = module.exports.convertDate.bind(undefined, 'ru', 'iso');
module.exports.convertDateIso2Ru = module.exports.convertDate.bind(undefined, 'iso', 'ru');

function isValid(str, format) {
    if (!str) {
        return false;
    }
    try {
        if (format == 'iso') {
            return str.match(/[0-9]{4}-[0-9]{2}-[0-9]{2}/gi) && moment(str).isValid();
        } else {
            return str.match(/[0-9]{2}\.[0-9]{2}\.[0-9]{4}/gi) && moment(str, 'DD.MM.YYYY HH:mm:ss').isValid();
        }
    } catch (err) {
        console.log(err);
    }

    return false;
}

module.exports.isValid = isValid;

function parseDateSmart(str) {
    let result = false;
    if (isValid(str, 'ru')) {
        result = parseDate(str, 'ru');
    } else if (isValid(str, 'iso')) {
        result = parseDate(str, 'iso');
    }

    return result;
}
module.exports.parseDateSmart = parseDateSmart;

function clearDateClock(obj) {
    let date = new Date(obj);
    date.setHours(0);
    date.setMinutes(0);
    date.setSeconds(0);
    date.setMilliseconds(0);

    return date;
}

module.exports.getStartTodayDate = function () {
    let date = new Date();
    date = clearDateClock(date);

    return date;
}

module.exports.getStartCurrentWeekDate = function () {
    let date = new Date();
    date.setDate(date.getDate() - (date.getDay() > 0 ? date.getDay() - 1 : 6));
    date = clearDateClock(date);

    return date;
}

module.exports.getStartCurrentMonthDate = function () {
    let date = new Date();
    date.setDate(3);
    date = clearDateClock(date);

    return date;
}

module.exports.getDateNow = function() {
    return Date.now();
}