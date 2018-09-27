let config = require('../config')
    , proxy = require('../utils/proxy')
    , datesHelper = require('../utils/dates-helper')
    , fs = require('fs')
    , mkdirp = require('mkdirp')
    , path = require('path')
    ;

const HISTORY_FROM_DAYS_BEFORE = 400
    , MS_IN_DAY = 24 * 60 * 60 * 1000
    , MAX_HISTORY_FROM_DAYS_BEFORE = 1000
    ;

function Security (ticker, initOpts) {
    initOpts = initOpts && typeof initOpts == 'object' ? initOpts : {};
    this.opts = initOpts;
    this.ticker = ticker;
    if (typeof this.opts.provider == 'object') {
        this.provider = this.opts.provider;
    } else {
        this.provider = proxy(this.opts.provider)(this.ticker);
    }
    this.history = [];
    this.indicators = {};
    this.price = 0.0;
}

//getters
Security.prototype.getTicker = function() {
    return this.ticker;
}

Security.prototype.getPrice = function() {
    return this.price;
}

Security.prototype.getVolume = function() {
    return this.volume;
}

Security.prototype.getLotSize = function() {
    return this.lotSize;
}

Security.prototype.getAvgPrice = function() {
    return false;
}

Security.prototype.getIndicator = function (key) {
    return this.indicators[key] || false;
}

Security.prototype.getDate = function () {
    return datesHelper.getCurrentDate();
}

//public methods
Security.prototype.init = async function() {
    if (this.opts.fillHistory) {
        await this._fillHistory();
    }
    let securityData = await this._getCurrentData();
    this.currentData = securityData;

    let commonData = await this._getSecurityCommonData();
    this.commonData = commonData;

    this.price = securityData.last;
    this.volume = securityData.volume;
    if (this.price && this.opts.fillHistory) {
        let item = {
            close: this.price,
            date: datesHelper.getDate(datesHelper.parseDateSmart(securityData.date), 'iso')
        };
        this.history.push(item);
    }
    if (this.opts.fillLotSize) {
        this.lotSize = commonData.lotSize;
    }
}

Security.prototype.refresh = async function() {
    let securityData = await this._getCurrentData();
    this.price = securityData.last;
    this.volume = securityData.volume;
    if (this.price && this.opts.fillHistory) {
        let item = {
            CLOSE: this.price,
            TRADEDATE: datesHelper.getDate(datesHelper.parseDateSmart(securityData.SYSTIME), 'iso')
        };
        this.history = this.history.slice(0, this.history.length - 2);
        this.history.push(item);
    }
}

Security.prototype.addIndicator = function (name, key, args) {
    if (!fs.existsSync(path.join(__dirname, 'indicators', name + '.js'))) {
        return false;
    }
    let Indicator = require('./indicators/' + name);
    args.unshift(this);
    this.indicators[key] = new Indicator(...args);

    return this.indicators[key];
}

Security.prototype.save = function() {
    let data = {
        buyOrders: this.buyOrders || []
    };
    let json = JSON.stringify(data);
    let dataPath = path.join(__dirname, 'data');
    let dataFile = path.join(dataPath, this.ticker.replace(/\//g, '_') + '.json');
    if (!fs.existsSync(dataPath)) {
        mkdirp.sync(dataPath);
    }
    fs.writeFileSync(dataFile, json);

    console.log(this.ticker, 'saved');
}

Security.prototype.load = function() {
    let dataPath = path.join(__dirname, 'data');
    let dataFile = path.join(dataPath, this.ticker.replace(/\//g, '_') + '.json');
    if (!fs.existsSync(dataFile)) {
        console.log(this.ticker, 'nothing to load');
        return ;
    }
    let json = fs.readFileSync(dataFile);
    let data = JSON.parse(json);

    if (data.buyOrders) {
        this.buyOrders = data.buyOrders;
    }

    console.log(this.ticker, 'loaded');
}

//private methods
Security.prototype._getCurrentData = async function() {
    let securityData = await this.provider.getCurrentData();
    return securityData;
}

Security.prototype._getSecurityCommonData = async function() {
    let data = await this.provider.getSecurityCommonData();
    return data;
}

Security.prototype._getHistory = async function(fromDate, tillDate) {
    if (fromDate instanceof Date) {
        fromDate = datesHelper.getDate(fromDate);
    }
    if (tillDate instanceof Date) {
        tillDate = datesHelper.getDate(tillDate);
    }

    let response = await this.provider.getHistory(fromDate, tillDate);

    return response;
}

module.exports = Security;