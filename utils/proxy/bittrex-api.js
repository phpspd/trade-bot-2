let request = require('../awaitable-request')
    , queryString = require('qs')
    , datesHelper = require('../../utils/dates-helper')
    , config = require('../../config')
    , CryptoJS = require('crypto-js')
    , SHA512 = CryptoJS.SHA512
    ;

let sendRequest = async function(url, headers) {
    let reqOpts = {
        url: url,
        method: 'GET'
    }
    if (headers) {
        reqOpts.headers = headers;
    }
    let response = await request(reqOpts);
    try {
        response = JSON.parse(response);
        return response;
    } catch (err) {

    }
    return false;
}

function BittrexAPI (ticker) {
    let apiTicker = ticker.replace('/', '-');

    const BASE = config.get('Bittrex').host;
    const API_KEY = config.get('Bittrex').apiKey || '';
    const SECRET_KEY = config.get('Bittrex').secretKey || '';

    function signParams(url, secretKey) {
        return SHA256(url, secretKey).toString();
    }

    function getHeaders(signature) {
        return {
            "apisign": signature
        }  
    }

    let methods = {};
    methods.getCurrentData = async function(all) {
        all = all || false;
        let response = await sendRequest(BASE + '/public/' + (!all ? 'getmarketsummaries' : 'getmarketsummary?market=' + apiTicker));
        if (!response.success) {
            console.warn(response);
            return false;
        }

        let result = response.result.map((item) => {
            return {
                ticker: item.MarketName.replace('-', '/'),
                last: item.Last,
                high: item.High,
                low: item.Low,
                volume: item.BaseVolume,
                max_bid: item.Bid,
                min_ask: item.Ask
            }  
        });

        if (!all) {
            return result[0];
        }
        return result;
    }

    methods.getOrderBook = async function() {
        let response = await sendRequest(BASE + '/public/getorderbook?market=' + apiTicker + '&type=both');
        if (!response.success) {
            console.warn(response);
            return false;
        }
        if (response.result.buy) {
            for (let i = 0; i < response.result.buy.length; ++i) {
                let ask = response.result.buy[i];
                let item = {
                    price: ask.Rate,
                    amount: ask.Quantity
                };
                response.asks[i] = item;
            }
        }
        if (response.result.sell) {
            for (let i = 0; i < response.result.sell.length; ++i) {
                let bid = response.result.sell[i];
                let item = {
                    price: bid.Rate,
                    amount: bid.Quantity
                };
                response.bids[i] = item;
            }
        }

        return response;
    }
    methods.getGlass = async function() {
        let response = await sendRequest(BASE + '/public/getticker?market=' + apiTicker);

        if (!response.success) {
            console.warn(response);
            return false;
        }

        let item = response.result;
        let result = {
            maxBid: item.Bid,
            minAsk: item.Ask,
            last: item.Last
        }

        return result;
    }
    methods.getSecurityCommonData = async function() {
        let result = {};
        let response = await sendRequest(BASE + '/public/getmarkets');

        if (!response.success) {
            console.warn(response);
            return false;
        }

        let item = response.result.filter((item) => { return item.MarketName == apiTicker });
        if (item.length != 1) {
            return false;
        }

        item = item[0];

        result = {
            priceScale: 8, //TODO
            minLimitQuantity: item.MinTradeSize
        }



        return result;
    }

    methods.getOrders = async function() {
        let url = BASE + '/account/getorderhistory?apikey=' + API_KEY + '&market=' + apiTicker + '&nonce=' + Date.now();
        let signature = signParams(url, SECRET_KEY);
        let headers = getHeaders(signature);

        let response = await sendRequest(url, null, null, headers);

        if (!response.success) {
            console.warn(response);
            return false;
        }

        return response.result.map((item) => {
            return {
                id: item.OrderUuid,
                currencyPair: item.Exchange.replace('-', '/'),
                type: item.OrderType,
                issueTime: +datesHelper.parseDateSmart(item.TimeStamp),
                price: item.PricePerUnit,
                quantity: item.Quantity,
                remainingQuantity: item.QuantityRemaining,
                commission: item.Commission
            }  
        });
    }

    methods.getBalance = async function(currency) {
        let url = BASE + '/account/getbalance?apikey=' + API_KEY + '&currency=' + currency + '&nonce=' + Date.now();
        let signature = signParams(url, SECRET_KEY);
        let headers = getHeaders(signature);

        let response = await sendRequest(url, null, null, headers);

        if (!response.success) {
            console.warn(response);
            return false;
        }

        return response.result.Available;
    }

    /*methods.getCommission = async function() {
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
    }*/

    methods.buyLimit = async function(price, quantity) {
        let url = BASE + '/market/buylimit?apikey=' + API_KEY + '&market=' + apiTicker + '&quantity=' + quantity + '&rate=' + price + '&nonce=' + Date.now();
        let signature = signParams(url, SECRET_KEY);
        let headers = getHeaders(signature);

        let response = await sendRequest(url, null, null, headers);

        if (!response.success) {
            console.warn(response);
            return false;
        }

        return {
            success: response.success,
            added: true,
            orderId: response.result.uuid
        };
    }

    methods.sellLimit = async function(price, quantity) {
        let url = BASE + '/market/selllimit?apikey=' + API_KEY + '&market=' + apiTicker + '&quantity=' + quantity + '&rate=' + price + '&nonce=' + Date.now();
        let signature = signParams(url, SECRET_KEY);
        let headers = getHeaders(signature);

        let response = await sendRequest(url, null, null, headers);

        if (!response.success) {
            console.warn(response);
            return false;
        }

        return {
            success: response.success,
            added: true,
            orderId: response.result.uuid
        };
    }

    methods.cancelLimit = async function(orderId) {
        let url = BASE + '/market/cancel?apikey=' + API_KEY + '&uuid=' + orderId + '&nonce=' + Date.now();
        let signature = signParams(url, SECRET_KEY);
        let headers = getHeaders(signature);

        let response = await sendRequest(url, null, null, headers);

        if (!response.success) {
            console.warn(response);
            return false;
        }

        return {
            success: response.success
        };
    }

    return methods;
}

module.exports = BittrexAPI;