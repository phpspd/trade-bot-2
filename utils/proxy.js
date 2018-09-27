let request = require('./awaitable-request')
    , queryString = require('qs')
    , datesHelper = require('../utils/dates-helper')
    //, Micex = require('micex.api')
    , config = require('../config')
    , CryptoJS = require('crypto-js')
    , HmacSHA256 = CryptoJS.HmacSHA256
    ;

let ORDER_COUNTER = 0;

let sendRequest = async function(url, method, body, headers) {
    let reqOpts = {
        url: url,
        method: method || 'GET'
    }
    if (body) {
        if (typeof body == 'object') {
            body = queryString.stringify(body);
        }
        reqOpts.body = body;
    }
    if (headers) {
        reqOpts.headers = headers;
        if (body) {
            reqOpts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
        }
    }
    let response = await request(reqOpts);
    try {
        response = JSON.parse(response);
        return response;
    } catch (err) {

    }
    return false;
}

function getProvider(providerName) {
    if (providers[providerName]) {
        return providers[providerName];
    }

    return providers.default;
}

let providers = {};
providers.default = function(ticker) {
    let methods = {};
    methods.getCurrentData = async function() {
        return {
            last: 0,
            high: 0,
            low: 0,
            volume: 0,
            max_24bid: 0,
            min_24ask: 0,
            max_bid: 0,
            min_ask: 0
        }
    }
    methods.getSecurityCommonData = async function() {
        return {
            lotSize: 0
        }
    }

    return methods;
};

providers.LiveCoin = function(ticker) {
    const BASE = config.get('LiveCoin').host || 'https://api.livecoin.net';
    const API_KEY = config.get('LiveCoin').apiKey || '';
    const SECRET_KEY = config.get('LiveCoin').secretKey || '';

    function signParams(params, secretKey) {
        return HmacSHA256(queryString.stringify(params), secretKey).toString().toUpperCase();
    }

    function getHeaders(signature) {
        return {
            "Api-Key": API_KEY,
            "Sign": signature
        }  
    }

    let methods = {};
    methods.getCurrentData = async function(all) {
        all = all || false;
        let response = await sendRequest(BASE + '/exchange/ticker' + (!all ? '?currencyPair=' + ticker : ''));
        if (Array.isArray(response)) {
            return response.map((item) => {
                return {
                    ticker: item.symbol,
                    last: item.last,
                    high: item.high,
                    low: item.low,
                    volume: item.volume * item.last,
                    max_24bid: item.max_bid,
                    min_24ask: item.min_ask,
                    max_bid: item.best_bid,
                    min_ask: item.best_ask
                }  
            });
        }

        let data = {
            ticker: ticker,
            last: response.last,
            high: response.high,
            low: response.low,
            volume: response.volume * response.last,
            max_24bid: response.max_bid,
            min_24ask: response.min_ask,
            max_bid: response.best_bid,
            min_ask: response.best_ask
        }
        return data;
    }
    methods.getOrderBook = async function() {
        let response = await sendRequest(BASE + '/exchange/order_book?currencyPair=' + ticker + '&groupByPrice=true');
        if (response.asks) {
            for (let i = 0; i < response.asks.length; ++i) {
                let ask = response.asks[i];
                let item = {
                    price: ask[0],
                    amount: ask[1]
                };
                response.asks[i] = item;
            }
        }
        if (response.bids) {
            for (let i = 0; i < response.bids.length; ++i) {
                let bid = response.bids[i];
                let item = {
                    price: bid[0],
                    amount: bid[1]
                };
                response.bids[i] = item;
            }
        }

        return response;
    }
    methods.getGlass = async function() {
        let response = await sendRequest(BASE + '/exchange/maxbid_minask?currencyPair=' + ticker);

        if (response.currencyPairs.length != 1) {
            return false;
        }

        let item = response.currencyPairs[0];
        let result = {
            maxBid: item.maxBid,
            minAsk: item.minAsk
        }

        return result;
    }
    methods.getSecurityCommonData = async function() {
        let result = {};
        let response = await sendRequest(BASE + '/exchange/restrictions');

        if (!response.success) {
            console.warn(response);
            return false;
        }

        let item = response.restrictions.filter((item) => { return item.currencyPair == ticker });
        if (item.length != 1) {
            return false;
        }

        item = item[0];

        result = {
            minVolume: response.minBtcVolume,
            priceScale: item.priceScale,
            minLimitQuantity: item.minLimitQuantity
        }



        return result;
    }

    methods.getOrders = async function(orderType) {
        let params = {
            currencyPair: ticker
        }
        if (orderType) {
            params.openClosed = orderType;
        }
        let signature = signParams(params, SECRET_KEY);
        let headers = getHeaders(signature);
        let query = queryString.stringify(params);

        let response = await sendRequest(BASE + '/exchange/client_orders?' + query, null, null, headers);

        /*if (!response.success) {
            console.warn(response);
            return false;
        }*/

        return response;
    }

    methods.getBalance = async function(currency) {
        let params = {
            currency: currency
        };
        let signature = signParams(params, SECRET_KEY);
        let headers = getHeaders(signature);
        let query = queryString.stringify(params);

        let response = await sendRequest(BASE + '/payment/balance?' + query, null, null, headers);

        /*if (!response.success) {
            console.warn(response);
            return false;
        }*/

        return response.value;
    }

    methods.getCommission = async function() {
        let params = {
        };
        let signature = signParams(params, SECRET_KEY);
        let headers = getHeaders(signature);
        let query = queryString.stringify(params);
        let response = await sendRequest(BASE + '/exchange/commission', null, null, headers);

        if (!response.success) {
            console.warn(response);
            return false;
        }

        return response.fee;
    }

    methods.buyLimit = async function(price, quantity) {
        let body = {
            currencyPair: ticker,
            price: price,
            quantity: quantity
        }
        let signature = signParams(body, SECRET_KEY);
        let headers = getHeaders(signature);

        let response = await sendRequest(BASE + '/exchange/buylimit', 'POST', body, headers);
        /*let response = {
            success: true,
            added: true,
            orderId: ++ORDER_COUNTER
        }*/

        if (!response.success) {
            console.warn(response);
            return false;
        }

        return response;
    }

    methods.sellLimit = async function(price, quantity) {
        let body = {
            currencyPair: ticker,
            price: price,
            quantity: quantity
        }
        let signature = signParams(body, SECRET_KEY);
        let headers = getHeaders(signature);

        let response = await sendRequest(BASE + '/exchange/selllimit', 'POST', body, headers);
        /*let response = {
            success: true,
            added: true,
            orderId: ++ORDER_COUNTER
        }*/

        if (!response.success) {
            console.warn(response);
            return false;
        }

        return response;
    }

    methods.buyMarket = async function(quantity) {
        let body = {
            currencyPair: ticker,
            quantity: quantity
        }
        let signature = signParams(body, SECRET_KEY);
        let headers = getHeaders(signature);

        let response = await sendRequest(BASE + '/exchange/buymarket', 'POST', body, headers);
        /*let response = {
            success: true,
            added: true,
            orderId: ++ORDER_COUNTER
        }*/

        if (!response.success) {
            console.warn(response);
            return false;
        }

        return response;
    }

    methods.sellMarket = async function(quantity) {
        let body = {
            currencyPair: ticker,
            quantity: quantity
        }
        let signature = signParams(body, SECRET_KEY);
        let headers = getHeaders(signature);

        let response = await sendRequest(BASE + '/exchange/sellmarket', 'POST', body, headers);
        /*let response = {
            success: true,
            added: true,
            orderId: ++ORDER_COUNTER
        }*/

        if (!response.success) {
            console.warn(response);
            return false;
        }

        return response;
    }

    methods.cancelLimit = async function(orderId) {
        let body = {
            currencyPair: ticker,
            orderId: orderId
        }
        let signature = signParams(body, SECRET_KEY);
        let headers = getHeaders(signature);

        let response = await sendRequest(BASE + '/exchange/cancellimit', 'POST', body, headers);
        /*let response = {
            success: true,
            cancelled: true,
            exception: null,
            orderId: ++ORDER_COUNTER
        }*/

        if (!response.success) {
            console.warn(response);
            return false;
        }

        return response;
    }

    return methods;
}

providers.Bittrex = require('./proxy/bittrex-api');

module.exports = getProvider;