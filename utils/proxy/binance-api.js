let request = require('../awaitable-request')
    , queryString = require('qs')
    , datesHelper = require('../../utils/dates-helper')
    , config = require('../../config')
    , CryptoJS = require('crypto-js')
    , HmacSHA256 = CryptoJS.HmacSHA256
    ;

const REFRESH_LIMITS_TIME = 60 * 60 * 1000; //1 h
let LAST_REFRESH_LIMITS_TIME = 0;

let LAST_REFRESH_CURRENT_SECOND_LIMITS_TIME = 0;
let LAST_REFRESH_CURRENT_MINUTE_LIMITS_TIME = 0;
let LAST_REFRESH_CURRENT_DAY_LIMITS_TIME = 0;

let CURRENT_SECOND_WEIGHT = 0;
let CURRENT_MINUTE_WEIGHT = 0;
let CURRENT_DAY_WEIGHT = 0;

let CURRENT_SECOND_ORDERS = 0;
let CURRENT_MINUTE_ORDERS = 0;
let CURRENT_DAY_ORDERS = 0;

let LIMIT_SECOND_WEIGHT = 2;
let LIMIT_MINUTE_WEIGHT = 4;
let LIMIT_DAY_WEIGHT = 10;

let LIMIT_SECOND_ORDERS = 0;
let LIMIT_MINUTE_ORDERS = 0;
let LIMIT_DAY_ORDERS = 0;

let SYMBOLS = [];

let sendRequest = async function(weight, orders, method, url, headers, noCheckLimits) {
    if (typeof weight != 'number' || weight <= 0) {
        throw new Error('weight must be a number greater than 0');
    }
    if (!noCheckLimits) {
        let checkResponse = await checkLimits(weight, orders);
        if (checkResponse.status !== 0) {
            return checkResponse;
        }
    }

    let reqOpts = {
        url: url,
        method: method || 'GET'
    }
    if (headers) {
        reqOpts.headers = headers;
    }
    let response = await request(reqOpts);
    try {
        response = JSON.parse(response);
        return response;
    } catch (err) {
        return {
            status: 2,
            message: err.message
        };
    }
}

async function checkLimits(weight, orders) {
    if (LAST_REFRESH_CURRENT_LIMITS_TIME) {
        let seconds = Math.floor((Date.now() - LAST_REFRESH_CURRENT_SECOND_LIMITS_TIME) / 1000);
        if (seconds) {
            if (LIMIT_SECOND_ORDERS !== -1) {
                CURRENT_SECOND_ORDERS -= (seconds * LIMIT_SECOND_ORDERS);
                CURRENT_SECOND_ORDERS = CURRENT_SECOND_ORDERS < 0 ? 0 : CURRENT_SECOND_ORDERS;
            }
            if (LIMIT_SECOND_WEIGHT !== -1) {
                CURRENT_SECOND_WEIGHT -= (seconds * LIMIT_SECOND_WEIGHT);
                CURRENT_SECOND_WEIGHT = CURRENT_SECOND_WEIGHT < 0 ? 0 : CURRENT_SECOND_WEIGHT;
            }

            LAST_REFRESH_CURRENT_SECOND_LIMITS_TIME = Date.now();
        }
        let minutes = Math.floor((Date.now() - LAST_REFRESH_CURRENT_MINUTE_LIMITS_TIME) / 60 / 1000);
        if (minutes) {
            if (LIMIT_MINUTE_ORDERS !== -1) {
                CURRENT_MINUTE_ORDERS -= (minutes * LIMIT_MINUTE_ORDERS);
                CURRENT_MINUTE_ORDERS = CURRENT_MINUTE_ORDERS < 0 ? 0 : CURRENT_MINUTE_ORDERS;
            }
            if (LIMIT_MINUTE_WEIGHT !== -1) {
                CURRENT_MINUTE_WEIGHT -= (minutes * LIMIT_MINUTE_WEIGHT);
                LIMIT_MINUTE_WEIGHT = LIMIT_MINUTE_WEIGHT < 0 ? 0 : LIMIT_MINUTE_WEIGHT;
            }
            LAST_REFRESH_CURRENT_MINUTE_LIMITS_TIME = Date.now();
        }
        let days = Math.floor((Date.now() - LAST_REFRESH_CURRENT_MINUTE_LIMITS_TIME) / 24 / 60 / 60 / 1000);
        if (days) {
            if (LIMIT_DAY_ORDERS !== -1) {
                CURRENT_DAY_ORDERS -= (days * LIMIT_DAY_ORDERS);
                CURRENT_DAY_ORDERS = CURRENT_DAY_ORDERS < 0 ? 0 : CURRENT_DAY_ORDERS;
            }
            if (LIMIT_DAY_WEIGHT !== -1) {
                CURRENT_DAY_WEIGHT -= (days * LIMIT_DAY_WEIGHT);
                CURRENT_DAY_WEIGHT = CURRENT_DAY_WEIGHT < 0 ? 0 : CURRENT_DAY_WEIGHT;
            }
            LAST_REFRESH_CURRENT_DAY_LIMITS_TIME = Date.now();
        }
    }
    if (!LAST_REFRESH_CURRENT_SECOND_LIMITS_TIME) {
        LAST_REFRESH_CURRENT_SECOND_LIMITS_TIME = Date.now();
    }
    if (!LAST_REFRESH_CURRENT_MINUTE_LIMITS_TIME) {
        LAST_REFRESH_CURRENT_MINUTE_LIMITS_TIME = Date.now();
    }
    if (!LAST_REFRESH_CURRENT_DAY_LIMITS_TIME) {
        LAST_REFRESH_CURRENT_DAY_LIMITS_TIME = Date.now();
    }
    if (Date.now() > LAST_REFRESH_LIMITS_TIME + REFRESH_LIMITS_TIME) {
        if (!
            (
                (CURRENT_SECOND_WEIGHT < LIMIT_SECOND_WEIGHT || LIMIT_SECOND_WEIGHT === -1)
                && (CURRENT_MINUTE_WEIGHT < LIMIT_MINUTE_WEIGHT || LIMIT_MINUTE_WEIGHT === -1)
                && (CURRENT_DAY_WEIGHT < LIMIT_DAY_WEIGHT || LIMIT_DAY_WEIGHT === -1)
            )
        ) {
            return {
                status: 1,
                message: 'Limit violation prevented while refresh exchange limits'
            };
        }
        CURRENT_SECOND_WEIGHT++;
        CURRENT_MINUTE_WEIGHT++;
        CURRENT_DAY_WEIGHT++;

        let response = await exchangeInfo();
        LAST_REFRESH_LIMITS_TIME = response.serverTime;
        LIMIT_SECOND_WEIGHT = LIMIT_MINUTE_WEIGHT = LIMIT_DAY_WEIGHT = LIMIT_SECOND_ORDERS = LIMIT_MINUTE_ORDERS = LIMIT_DAY_ORDERS = 0;
        for (let limit of response.rateLimits) {
            if (limit.rateLimitType == 'REQUESTS_WEIGHT') {
                if (limit.interval == 'SECOND') {
                    LIMIT_SECOND_WEIGHT = limit.limit;
                }
                if (limit.interval == 'MINUTE') {
                    LIMIT_MINUTE_WEIGHT = limit.limit;
                }
                if (limit.interval == 'DAY') {
                    LIMIT_DAY_WEIGHT = limit.limit;
                }
            } else if (limit.rateLimitType == 'ORDERS') {
                if (limit.interval == 'SECOND') {
                    LIMIT_SECOND_ORDERS = limit.limit;
                }
                if (limit.interval == 'MINUTE') {
                    LIMIT_MINUTE_ORDERS = limit.limit;
                }
                if (limit.interval == 'DAY') {
                    LIMIT_DAY_ORDERS = limit.limit;
                }
            }
        }

        if (LIMIT_SECOND_WEIGHT == 0) {
            LIMIT_SECOND_WEIGHT = -1;
        }
        if (LIMIT_MINUTE_WEIGHT == 0) {
            LIMIT_MINUTE_WEIGHT = -1;
        }
        if (LIMIT_DAY_WEIGHT == 0) {
            LIMIT_DAY_WEIGHT = -1;
        }
        if (LIMIT_SECOND_ORDERS == 0) {
            LIMIT_SECOND_ORDERS = -1;
        }
        if (LIMIT_MINUTE_ORDERS == 0) {
            LIMIT_MINUTE_ORDERS = -1;
        }
        if (LIMIT_DAY_ORDERS == 0) {
            LIMIT_DAY_ORDERS = -1;
        }
    }

    if (!
        (
            (CURRENT_SECOND_WEIGHT + weight <= LIMIT_SECOND_WEIGHT || LIMIT_SECOND_WEIGHT === -1)
            && (CURRENT_MINUTE_WEIGHT + weight <= LIMIT_MINUTE_WEIGHT || LIMIT_MINUTE_WEIGHT === -1)
            && (CURRENT_DAY_WEIGHT + weight <= LIMIT_DAY_WEIGHT || LIMIT_DAY_WEIGHT === -1)
        )
    ) {
        return {
            status: 1,
            message: 'Limit violation prevented while refresh exchange limits'
        };
    }
    if (orders &&
        !(
            (CURRENT_SECOND_ORDERS < LIMIT_SECOND_ORDERS || LIMIT_SECOND_ORDERS === -1)
            && (CURRENT_MINUTE_ORDERS < LIMIT_MINUTE_ORDERS || LIMIT_MINUTE_ORDERS === -1)
            && (CURRENT_DAY_ORDERS < LIMIT_DAY_ORDERS || LIMIT_DAY_ORDERS === -1)
        )
    ) {
        return {
            status: 1,
            message: 'Limit violation prevented while refresh exchange limits'
        };
    }
    CURRENT_SECOND_WEIGHT += weight;
    CURRENT_MINUTE_WEIGHT += weight;
    CURRENT_DAY_WEIGHT += weight;
    if (orders) {
        CURRENT_SECOND_ORDERS++;
        CURRENT_MINUTE_ORDERS++;
        CURRENT_DAY_ORDERS++;
    }

    return {
        status: 0
    }
}

async function exchangeInfo() {
    let url = BASE + 'exchangeInfo';
    let response = await sendRequest(1, false, 'GET', url, null, 1);

    SYMBOLS = response.symbols.map((item) => {
        return {
            ticker: [item.baseAsset, item.quoteAsset].join('/'),
            symbol: item.symbol,
            priceScale: item.quoteAssetPrecision,
            quantityScale: item.baseAsset.priceAssetPrecision
        }
    });

    return response;
}

function BinanceAPI (ticker) {
    let apiTicker = ticker.replace('/', '-');

    const BASE = config.get('Binance').host;
    const API_KEY = config.get('Binance').apiKey || '';
    const SECRET_KEY = config.get('Binance').secretKey || '';

    function signParams(params, secretKey) {
        return SHA256(queryString.stringify(params), secretKey).toString();
    }

    function getHeaders() {
        return {
            "X-MBX-APIKEY": API_KEY
        }  
    }

    let methods = {};

    methods.getCurrentData = async function(all) {
        all = all || false;
        let symbols = all ? SYMBOLS : SYMBOLS.filter((item) => { return item.symbol == apiTicker });
        let result = [];

        for (let item of symbols) {
            let response = await sendRequest(1, false, 'GET', BASE + '/ticker/24hr?symbol=' + item.symbol);
            if (response.status) {
                console.warn(response);
                continue;
            }

            if (!Array.isArray(response)) {
                response = [ response ];
            }

            result = result.concat(response.map((item) => {
                return {
                    ticker: item.ticker,
                    last: item.lastPrice,
                    high: item.highPrice,
                    low: item.lowPrice,
                    volume: item.quoteVolume,
                    max_bid: item.bidPrice,
                    min_ask: item.askPrice
                }  
            }));

        }

        if (!all) {
            return result[0];
        }
        return result;
    }

    
}