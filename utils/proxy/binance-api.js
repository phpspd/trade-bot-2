let request = require('../awaitable-request')
    , queryString = require('qs')
    , datesHelper = require('../../utils/dates-helper')
    , config = require('../../config')
    , CryptoJS = require('crypto-js')
    , HmacSHA256 = CryptoJS.HmacSHA256
    ;


const BASE = config.get('Binance').host;
const API_KEY = config.get('Binance').apiKey || '';
const SECRET_KEY = config.get('Binance').secretKey || '';

const ORDER_STATUSES = {
    NEW: 'OPEN',
    PARTIALLY_FILLED: 'PARTIALLY',
    FILLED: 'EXECUTED',
    CANCELED: 'CANCELED',
    PENDING_CANCEL: 'CANCELED',
    REJECTED: 'CANCELED',
    EXPIRED: 'CANCELED'
}

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
    if (LAST_REFRESH_CURRENT_SECOND_LIMITS_TIME) {
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
    }
    if (LAST_REFRESH_CURRENT_MINUTE_LIMITS_TIME) {
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
    }
    if (LAST_REFRESH_CURRENT_DAY_LIMITS_TIME) {
        let days = Math.floor((Date.now() - LAST_REFRESH_CURRENT_DAY_LIMITS_TIME) / 24 / 60 / 60 / 1000);
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
            if (limit.rateLimitType == 'REQUEST_WEIGHT') {
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
    let url = BASE + '/v1/exchangeInfo';
    let response = await sendRequest(1, false, 'GET', url, null, 1);

    SYMBOLS = response.symbols.map((item) => {
        let result = {
            ticker: [item.baseAsset, item.quoteAsset].join('/'),
            symbol: item.symbol,
            priceScale: +item.quotePrecision,
            quantityScale: +item.baseAssetPrecision
        };

        if (Array.isArray(item.filters)) {
            let priceFilter = item.filters.filter((filter) => { return filter.filterType == 'PRICE_FILTER' });
            if (priceFilter.length) {
                priceFilter = priceFilter[0];
                if (priceFilter.minPrice) {
                    result.minPrice = +priceFilter.minPrice;
                }
                if (priceFilter.maxPrice) {
                    result.maxPrice = +priceFilter.maxPrice;
                }
                if (priceFilter.tickSize) {
                    result.priceStep = +priceFilter.tickSize;
                }
            }
            let lotSize = item.filters.filter((filter) => { return filter.filterType == 'LOT_SIZE' });
            if (lotSize.length) {
                lotSize = lotSize[0];
                if (lotSize.minQty) {
                    result.minQuantity = +lotSize.minQty;
                }
                if (lotSize.maxQty) {
                    result.maxQuantity = +lotSize.maxQty;
                }
                if (lotSize.stepSize) {
                    result.quantityStep = +lotSize.stepSize;
                }
            }
            let volumeSize = item.filters.filter((filter) => { return filter.filterType == 'MIN_NOTIONAL' });
            if (volumeSize.length) {
                volumeSize = volumeSize[0];
                if (volumeSize.minNotional) {
                    result.minVolume = +volumeSize.minNotional;
                }
            }
        }

        return result;
    });

    return response;
}

function BinanceAPI (ticker) {
    ticker = ticker || '';
    let apiTicker = ticker.replace('/', '');

    function signParams(params, secretKey) {
        return HmacSHA256(queryString.stringify(params), secretKey).toString();
    }

    function getHeaders() {
        return {
            "X-MBX-APIKEY": API_KEY
        }  
    }

    let methods = {};

    methods.getCurrentData = async function(all) {
        all = all || false;
        if (!SYMBOLS.length) {
            await exchangeInfo();
        }
        //let symbols = all ? SYMBOLS : SYMBOLS.filter((item) => { return item.symbol == apiTicker });
        let result = [];

        //for (let item of symbols) {
            let response = await sendRequest(!all ? 1 : 40, false, 'GET', BASE + '/v1/ticker/24hr' + (!all ? '?symbol=' + apiTicker : ''));
            if (response.status) {
                console.warn(response);
                return false;
            }

            if (!Array.isArray(response)) {
                response = [ response ];
            }

            result = result.concat(response.map((resultItem) => {
                let item = SYMBOLS.filter((item) => { return item.symbol == resultItem.symbol });
                if (item.length) {
                    item = item[0];
                }
                return {
                    ticker: item.ticker || '',
                    last: +resultItem.lastPrice,
                    high: +resultItem.highPrice,
                    low: +resultItem.lowPrice,
                    volume: +resultItem.quoteVolume,
                    max_bid: +resultItem.bidPrice,
                    min_ask: +resultItem.askPrice
                }  
            }));

        //}

        if (!all) {
            return result[0];
        }
        return result;
    }

    
    methods.getSecurityCommonData = async function() {
        if (!SYMBOLS.length) {
            await exchangeInfo();
        }
        let result = SYMBOLS.filter((item) => { return item.ticker == ticker });
        if (!result.length) {
            console.log('Ticker', ticker, 'not found');
            return false;
        }

        /*result = {
            minVolume: response.minBtcVolume,
            priceScale: item.priceScale,
            minLimitQuantity: item.minLimitQuantity
        }*/

        return result[0];
    }

    methods.getOrder = async function(orderId) {
        let params = {
            symbol: apiTicker,
            orderId: orderId,
            timestamp: Date.now()
        };
        let signature = signParams(params, SECRET_KEY);
        params.signature = signature;
        let headers = getHeaders();
        let response = await sendRequest(1, false, 'GET', BASE + '/v3/order?' + queryString.stringify(params), headers);

        /*if (!response.success) {
            console.warn(response);
            return false;
        }*/
        let symbol = SYMBOLS.filter((item) => { return item.symbol == response.symbol });
        if (!symbol.length) {
            console.warn('order', orderId, 'not found');
            return false;
        }
        symbol = symbol[0];

        let result = {
            id: response.orderId,
            currencyPair: symbol.ticker,
            type: [response.type, response.side].join('_'),
            orderStatus: ORDER_STATUSES[response.status],
            issueTime: response.time,
            price: response.price,
            quantity: response.origQty,
            remainingQuantity: +(+response.origQty - (+response.executedQty)).toFixed(symbol.quantityScale),
            lastModificationTime: response.updateTime,
            isWorking: response.isWorking
        }

        return result;
    }

    let accountInfo = null;

    methods.getBalance = async function(currency) {
        if (!accountInfo) {
            let params = {
                timestamp: Date.now()
            };
            let signature = signParams(params, SECRET_KEY);
            params.signature = signature;
            let headers = getHeaders();
            let response = await sendRequest(5, false, 'GET', BASE + '/v3/account?' + queryString.stringify(params), headers);

            accountInfo = response;
        }
        
        let balance = accountInfo.balances.filter((item) => { return item.asset == currency });
        if (!balance.length) {
            return 0;
            //console.log('Balance', currency, 'not found');
            //return false;
        }

        accountInfo = null; //TODO

        /*if (!response.success) {
            console.warn(response);
            return false;
        }*/

        return +balance[0].free;
    }

    methods.buyLimit = async function(price, quantity) {
        let params = {
            symbol: apiTicker,
            side: 'BUY',
            type: 'LIMIT',
            timeInForce: 'GTC',
            quantity: quantity,
            price: price,
            timestamp: Date.now()
        };
        let signature = signParams(params, SECRET_KEY);
        params.signature = signature;
        let headers = getHeaders();

        let response = await sendRequest(1, true, 'POST', BASE + '/v3/order?' + queryString.stringify(params), headers);

        if (!response.orderId) {
            console.warn(response);
            return false;
        }

        return {
            orderId: response.orderId
        };
    }

    methods.sellLimit = async function(price, quantity) {
        let params = {
            symbol: apiTicker,
            side: 'SELL',
            type: 'LIMIT',
            timeInForce: 'GTC',
            quantity: quantity,
            price: price,
            timestamp: Date.now()
        };
        let signature = signParams(params, SECRET_KEY);
        params.signature = signature;
        let headers = getHeaders();

        let response = await sendRequest(1, true, 'POST', BASE + '/v3/order?' + queryString.stringify(params), headers);

        if (!response.orderId) {
            console.warn(response);
            return false;
        }

        return {
            orderId: response.orderId
        };
    }

    methods.buyMarket = async function(quantity) {
        let params = {
            symbol: apiTicker,
            side: 'BUY',
            type: 'MARKET',
            quantity: quantity,
            timestamp: Date.now()
        };
        let signature = signParams(params, SECRET_KEY);
        params.signature = signature;
        let headers = getHeaders();

        let response = await sendRequest(1, true, 'POST', BASE + '/v3/order?' + queryString.stringify(params), headers);

        if (!response.orderId) {
            console.warn(response);
            return false;
        }

        return {
            orderId: response.orderId
        };
    }

    methods.sellMarket = async function(quantity) {
        let params = {
            symbol: apiTicker,
            side: 'SELL',
            type: 'MARKET',
            quantity: quantity,
            price: price,
            timestamp: Date.now()
        };
        let signature = signParams(params, SECRET_KEY);
        params.signature = signature;
        let headers = getHeaders();

        let response = await sendRequest(1, true, 'POST', BASE + '/v3/order?' + queryString.stringify(params), headers);

        if (!response.orderId) {
            console.warn(response);
            return false;
        }

        return {
            orderId: response.orderId
        };
    }

    methods.cancelLimit = async function(orderId) {
        let params = {
            symbol: apiTicker,
            orderId: orderId,
            timestamp: Date.now()
        };
        let signature = signParams(params, SECRET_KEY);
        params.signature = signature;
        let headers = getHeaders();

        let response = await sendRequest(1, true, 'DELETE', BASE + '/v3/order?' + queryString.stringify(params), headers);

        if (!response.orderId) {
            console.warn(response);
            return false;
        }

        return {
            success: true,
            orderId: response.orderId
        };
    }

    return methods;
}

module.exports = BinanceAPI;