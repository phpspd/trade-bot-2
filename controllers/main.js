'use strict';

let ctrlName = 'main'
    , views = require('../utils/views')(ctrlName)
    , proxy = require('../utils/proxy')
    , fs = require('fs')
    , datesHelper = require('../utils/dates-helper')
    , path = require('path')
    ;

let Security = require('../classes/security')
    ;

/**
 * Method: ALL
 * URI: *
 * */
module.exports.common = function (req, res, next) {
    res.viewData = {};
    
    res.viewData.errors = [];

    next();
}

module.exports.strategy = async function (req, res, next) {
    try {
        let strategyName = req._parsedUrl.pathname.split('/').pop()
            , view = 'strategy'
            , viewData = {}
            ;

        res.viewData.layout = 'layout';

        let Strategy = require('../classes/strategy')
            , strategyClass = require('../strategies/' + strategyName)
            ;

        let strategy = new Strategy(strategyName, strategyClass.init, strategyClass.tick);
        await strategy.init();

        let tickData = await strategy._tick();

        res.viewData.content = views.render(view, viewData);
        if (!res.viewData.content) {
            res.viewData.content = 'Not found';
        }

        return next();
    } catch (err) {
        console.log(err);
    }
}

const TICKERS = [
    'ETH/BTC',
    //'LTC/BTC',
    //'ETH/USD'
]

const MAX_ORDER_TIME = 1 * 60 * 60 * 1000; //1h
const FIX_LOSS_TIME = 2 * 7 * 24 * 60 * 60 * 1000; //2w
const TOTAL_BALANCE = 0.01024;//0.00263;//17.55522361;
const RELATION_TO_TOTAL_BALANCE = 8;
const SAFE_RELATION_TO_TOTAL_BALANCE = 0.01;
const FIX_PROFIT = 1.025;
const CRYPT2CRYPT_PRECISION = 100000000; //8 symbols
const MIN_LAST_PRICE = 0.0002;
const MIN_VOLUME = 300;
const MAX_PAIRS = 10;
const MAX_OPENED_ORDERS = 1;

function createBuyOrder(orderId, issueTime, price, quantity, bought, sold) {
    return {
        orderId: orderId,
        issueTime: issueTime,
        price: price,
        quantity: quantity,
        bought: bought || false,
        sold: sold || false,
        sellInProgress: false,
        sellOrderId: null
    };
}

function getPrecision(num) {
    let result = 1;
    for (let i = 0; i < num; ++i) {
        result *= 10;
    }

    return result;
}

async function closeOrders(security, orderType) {
    let provider = security.provider;
    security.buyOrders = security.buyOrders || [];
    let buyOrders = [].concat(security.buyOrders.filter((item) => { return !item.canceled && !item.bought }), security.buyOrders.filter((item) => { return !item.canceled && !item.sold && item.bought && item.sellInProgress }));
    for (let buyOrder of buyOrders) {
        let order = await provider.getOrder(!buyOrder.bought ? buyOrder.orderId : buyOrder.sellOrderId);
        if (!order) {
            console.warn('Can\'t get info about buyOrder with orderId/sellOrderId', !buyOrder.bought ? buyOrder.orderId : buyOrder.sellOrderId);
            continue;
        }
        if (order.orderStatus == 'EXECUTED' || +(new Date(order.issueTime)) + MAX_ORDER_TIME < Date.now()) {
            if (order.orderStatus == 'PARTIALLY_FILLED_AND_CANCELLED' || order.orderStatus == 'EXECUTED' || await provider.cancelLimit(order.id)) {
                if (order.type == "LIMIT_SELL") {
                    buyOrder.sellInProgress = false;
                    if (order.remainingQuantity != order.sellQuantity) {
                        buyOrder.sold = true;
                        let precision = security.commonData.quantityScale ? getPrecision(security.commonData.quantityScale) : CRYPT2CRYPT_PRECISION;
                        buyOrder.sellQuantity = (order.sellQuantity * precision - order.remainingQuantity * precision) / precision;

                        if (order.remainingQuantity > 0) {
                            let quantity = order.remainingQuantity;

                            if (security.commonData.quantityStep) {
                                quantity -= quantity % security.commonData.quantityStep;
                            }
                            if (security.commonData.minQuantity && security.commonData.minQuantity > quantity) {
                                quantity = 0;
                            }
                            if (quantity && security.commonData.minVolume && buyOrder.price * quantity < security.commonData.minVolume) {
                                console.log(security.ticker, buyOrder.price, '*', quantity, buyOrder.price * quantity, '< minimal volume', security.commonData.minVolume);
                                quantity = 0;
                            }

                            if (quantity) {
                                let partOrder = createBuyOrder(buyOrder.orderId, buyOrder.issueTime, buyOrder.price, order.remainingQuantity);
                                if (partOrder && partOrder.orderId) {
                                    security.buyOrders.push(partOrder);
                                }
                            }
                        }
                    } else {
                        delete buyOrder['sellPrice'];
                    }
                } else if (order.type == "LIMIT_BUY") {
                    if (order.remainingQuantity != order.quantity) {
                        buyOrder.bought = true;
                        let precision = security.commonData.quantityScale ? getPrecision(security.commonData.quantityScale) : CRYPT2CRYPT_PRECISION;
                        buyOrder.quantity = (order.quantity * precision - order.remainingQuantity * precision) / precision;
                        buyOrder.boughtTime = Date.now();
                    } else {
                        security.buyOrders = security.buyOrders.filter((item) => { return item.orderId != buyOrder.orderId });
                    }
                }
            } else {
                console.warn('Unable to cancelLimit, id', order.id);
            }
        }
    }
}

function getRank(ticker) {
    let rank = (ticker.min_ask - ticker.max_bid) / ticker.max_bid * ticker.volume;
    console.log(ticker.ticker, 'rank', rank);
    return rank;
}

function calcRoundTrade(result, list, startCurrency, startQuantity, finishCurrency, take_profit, fee, maxDepth, depth) {
    finishCurrency = finishCurrency || startCurrency;
    maxDepth = maxDepth || 3;
    depth = depth || maxDepth;

    result = result || [];

    for (let ticker of list) {
        let tickerParts = ticker.ticker.split('/');
        let pos = tickerParts.indexOf(startCurrency);
        if (pos === -1 || depth === 1 && tickerParts.indexOf(finishCurrency) === -1) {
            continue;
        }
        let nextItem = null;
        if (pos === 1) {
            let price = ticker.min_ask;
            if (!price) {
                continue;
            }
            let quantity = +(((+(startQuantity / price).toFixed(8)) * (+(1 - fee).toFixed(8))).toFixed(8));
            nextItem = {
                ticker: ticker.ticker,
                nextCurrency: tickerParts[0],
                price: price,
                quantity: quantity,
                next: []
            };
        } else if (pos === 0) {
            let price = ticker.max_bid;
            if (!price) {
                continue;
            }
            let quantity = +(((+(startQuantity * price).toFixed(8)) * (+(1 - fee).toFixed(8))).toFixed(8));
            nextItem = {
                ticker: ticker.ticker,
                nextCurrency: tickerParts[1],
                price: price,
                quantity: quantity,
                next: []
            };
        }
        if (nextItem) {
            if (depth > 1) {
                nextItem.next = calcRoundTrade(nextItem.next, list, nextItem.nextCurrency, nextItem.quantity, finishCurrency, take_profit, fee, maxDepth, depth - 1);
                if (!nextItem.next.length) {
                    continue;
                }
            }
            result.push(nextItem);
        }
    }

    if (depth == maxDepth) {
        function filterNext(arr, finishCurrency, take_profit, depth) {
            return arr.filter((item) => {
                if (depth > 1 && item.next.length) {
                    item.next = filterNext(item.next, finishCurrency, take_profit, depth - 1);
                    if (!item.next.length) {
                        return false;
                    }
                } else {
                    if (item.nextCurrency != finishCurrency || item.quantity < take_profit) {
                        return false;
                    }
                }

                return true;
            });
        }

        result = filterNext(result, finishCurrency, take_profit, maxDepth);
    }

    return result;
}

let LIST = [];

async function getRankedList(provider, minLastPrice, minVolume, relationTo, relMaxMin24hPrice, relAskToAvg24hPrice) {
    if (typeof provider == 'string') {
        provider = proxy(provider)();
    }
    let list = await provider.getCurrentData(true, relationTo);
    if (!Array.isArray(list)) {
        return false;
    }
    LIST = list;

    for (let ticker of list) {
        ticker.rank = getRank(ticker);
    }

    if (minLastPrice > 0) {
        list = list.filter((item) => { return item.last >= minLastPrice });
    }

    if (minVolume > 0) {
        list = list.filter((item) => { return item.volume >= minVolume });
    }

    if (relMaxMin24hPrice) {
        list = list.filter((item) => { return item.high / item.low >= relMaxMin24hPrice })
    }

    if (relAskToAvg24hPrice) {
        list = list.filter((item) => { return item.min_ask / ((item.high + item.low) / 2) <= relAskToAvg24hPrice })
    }

    if (typeof relationTo == 'string') {
        relationTo = relationTo.toUpperCase();
        list = list.filter((item) => { return item.ticker.split('/')[1] == relationTo });
    }

    list.sort((item1, item2) => {
        if (item1.rank > item2.rank) {
            return -1;
        } else if (item2.rank > item1.rank) {
            return 1;
        }
        return 0;
    });

    return list;
}

async function tickBot() {
    console.log('Call tickBot');
    try {

        let rankedSecurities = [];
        let allSecurities = [];

        let fullRankedList = await getRankedList('Binance', false, false, 'BTC');
        let rankedList = await getRankedList('Binance', MIN_LAST_PRICE, MIN_VOLUME, 'BTC', 1.04);
        if (Array.isArray(rankedList)) {
            console.log('Ranked list', rankedList.map((item) => { return { ticker: item.ticker, rank: item.rank } }));
        } else {
            rankedList = [];
        }

        for (let item of rankedList) {
            let security = new Security(item.ticker, { provider: 'Binance' });
            security.load();

            rankedSecurities.push(security);
            allSecurities.push(security);
            if (rankedSecurities.length >= MAX_PAIRS) {
                break;
            }
        }

        for (let item of fullRankedList) {
            if (allSecurities.filter((existsItem) => { return item.ticker == existsItem.ticker }).length) {
                continue;
            }

            let security = new Security(item.ticker, { provider: 'Binance' });
            security.load();

            if (security.buyOrders && security.buyOrders.filter((item) => { return !item.sold }).length) {
                allSecurities.push(security);
            }
        }

        for (let security of allSecurities) {
            let provider = security.provider;

            await security.init();

            let currencyName = security.getTicker().split('/')[0];
            //let currencyBalance = await provider.getBalance(currencyName);

            /*await closeOrders(security, 'OPEN');
            await closeOrders(security, 'PARTIALLY');
            await closeOrders(security, 'CLOSED');*/
            await closeOrders(security, 'NOT_CANCELLED');
        }

        for (let security of allSecurities) {
            let provider = security.provider;

            let min_ask = security.currentData.min_ask;
            let max_bid = security.currentData.max_bid;
            let volume = security.currentData.volume;
            let rank = getRank(security.currentData);
            console.log('Rank', security.getTicker(), rank);
            let priceScale = security.commonData.priceScale;
            let quantityScale = security.commonData.quantityScale;
            let minQuantity = security.commonData.minQuantity;
            let pricePrecision = priceScale ? getPrecision(priceScale) : CRYPT2CRYPT_PRECISION;
            let quantityPrecision = quantityScale ? getPrecision(quantityScale) : CRYPT2CRYPT_PRECISION;
            let quantityStep = security.commonData.quantityStep;
            let priceStep = security.commonData.priceStep;
            let minVolume = security.commonData.minVolume;

            if (!priceScale) {
                console.warn(security.ticker, 'unable to load priceScale, skip this pair');
                continue;
            }

            security.buyOrders = security.buyOrders || [];
            for (let order of security.buyOrders) {
                if (order.sold || !order.bought || order.sellInProgress) {
                    continue;
                }

                let ask = Math.floor((min_ask - (1 / pricePrecision)) * pricePrecision) / pricePrecision;

                if (priceStep) {
                    ask = +(ask - (+(ask % priceStep).toFixed(priceScale)) + priceStep).toFixed(priceScale);
                }

                let quantity = +order.quantity.toFixed(priceScale);
                if (quantityStep) {
                    quantity -= quantity % quantityStep;
                    quantity = +quantity.toFixed(quantityScale);
                }
                let volume = +(ask * quantity).toFixed(priceScale);
                if (minVolume && volume < minVolume) {
                    console.log(security.ticker, ask, '*', quantity, volume, '< minimal volume', minVolume);
                    quantity = 0;
                }

                console.log(security.ticker, 'current profit', +(ask / order.price).toFixed(4), 'expected', FIX_PROFIT);
                
                if (quantity >= minQuantity && (ask >= (order.price * FIX_PROFIT * pricePrecision) / pricePrecision || order.boughtTime + FIX_LOSS_TIME <= Date.now())) {
                    console.log(security.ticker, 'try to sellLimit', ask, quantity);
                    let response = await provider.sellLimit(ask, quantity);

                    if (!response) {
                        console.warn('Unable to sellLimit, price', ask, 'quantity', quantity, 'response', response, 'order', order);
                    } else {
                        console.log(security.getTicker(), 'sellLimit, price', ask, 'quantity', quantity);
                        if (order.boughtTime + FIX_LOSS_TIME <= Date.now()) {
                            console.log(security.getTicker(), 'fix loss');
                        }
                        order.sellQuantity = quantity;
                        order.sellOrderId = response.orderId;
                        order.sellInProgress = true;
                        order.sellPrice = ask;
                    }
                }
            }

            if (rankedSecurities.filter((existsItem) => { return security.ticker == existsItem.ticker }).length) {
                //
                let fullBalance = TOTAL_BALANCE || 0;
                //let usdBalance = await provider.getBalance('USD');
                let currencyName = security.getTicker().split('/')[0];
                let currencyBalance = await provider.getBalance(currencyName);
                let btcName = security.getTicker().split('/')[1];
                let btcBalance = await provider.getBalance(btcName);

                if (fullBalance * SAFE_RELATION_TO_TOTAL_BALANCE < btcBalance/* && currencyBalance === 0*/ && security.buyOrders.filter((item) => { return !item.sold }).length < MAX_OPENED_ORDERS ) {
                    let availableBalance = Math.min(btcBalance - (fullBalance * SAFE_RELATION_TO_TOTAL_BALANCE), fullBalance / RELATION_TO_TOTAL_BALANCE);
                    let bid = Math.floor((max_bid + (1 / pricePrecision)) * pricePrecision) / pricePrecision;

                    if (priceStep) {
                        bid = +(bid - (+(bid % priceStep).toFixed(priceScale)) + priceStep).toFixed(priceScale);
                    }

                    let quantity = Math.floor((availableBalance / bid) * quantityPrecision) / quantityPrecision;
                    if (quantityStep) {
                        quantity -= quantity % quantityStep;
                        quantity = +quantity.toFixed(quantityScale);
                    }
                    let volume = +(bid * quantity).toFixed(priceScale);
                    if (minVolume && volume < minVolume) {
                        console.log(security.ticker, bid, '*', quantity, volume, '< minimal volume', minVolume);
                        quantity = 0;
                    }
                    if (quantity >= minQuantity) {

                        let response = await provider.buyLimit(bid, quantity);

                        if (!response) {
                            console.warn('Unable to buyLimit, price', bid, 'quantity', quantity, 'response', response);
                        } else {
                            console.log('buyLimit, price', bid, 'quantity', quantity);
                            let resultQuantity = +(quantity * 0.999).toFixed(quantityScale);
                            security.buyOrders = security.buyOrders || [];
                            security.buyOrders.push(createBuyOrder(response.orderId, Date.now(), bid, resultQuantity));
                        }
                        
                    }
                }
            }

            security.save();
        }
        
        let roundTrades3 = calcRoundTrade([], LIST, 'BTC', 1, 'BTC', 1.01, 0.001, 3);
        saveRoundTrades(3, roundTrades3);
        //console.log('Profitable roundTrades depth 3:', roundTrades3.length);
        let roundTrades4 = calcRoundTrade([], LIST, 'BTC', 1, 'BTC', 1.01, 0.001, 4);
        saveRoundTrades(4, roundTrades4);
        //console.log('Profitable roundTrades depth 4:', roundTrades4.length);

    } catch (err) {
        console.log(err);
    }
}

function saveRoundTrades(depth, data) {
    console.log('Profitable roundTrades ', depth, ':', data.length);
    if (data.length) {
        data = {
            time: datesHelper.getCurrentDateTime(),
            data: data
        };
        try {
            let filepath = path.join(__dirname, 'profitableTrades' + depth + '.json');
            let storedData = [];
            if (fs.existsSync(filepath)) {
                storedData = JSON.parse(fs.readFileSync(filepath));
            }
            storedData.push(data);
            fs.writeFileSync(filepath, JSON.stringify(storedData));
        } catch (err) {
            console.log('Unable to save roundTrades', err);
        }
    }
}

let intervalId = null;
module.exports.index = async function(req, res, next) {
    if (!intervalId) {
        tickBot();
        intervalId = setInterval(tickBot, 1 * 60 * 1000);
        console.log('Interval set');
    } else {
        console.log('Interval already set');
    }
    res.send('Ok');
}

/**
 * Method: ALL
 * URI: *
 * */
exports.commonEnd = function (req, res, next) {
    if (!res.viewData || !res.viewData.layout) {
        return next();
    }

    return res.render(res.viewData.layout, res.viewData, res.viewData.partials || null);
}