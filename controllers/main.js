'use strict';

let ctrlName = 'main'
    , views = require('../utils/views')(ctrlName)
    , proxy = require('../utils/proxy')
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
const TOTAL_BALANCE = 0.01;//0.00263;//17.55522361;
const RELATION_TO_TOTAL_BALANCE = 8;
const SAFE_RELATION_TO_TOTAL_BALANCE = 0.1;
const FIX_PROFIT = 1.024;
const CRYPT2CRYPT_PRECISION = 100000000; //8 symbols
const MIN_LAST_PRICE = 0.00001;
const MIN_VOLUME = 10;
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
    let buyOrders = [].concat(security.buyOrders.filter((item) => { return !item.canceled && !item.bought }), security.buyOrders.filter((item) => { return !item.canceled && !item.sold && item.bought }));
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
                    if (order.remainingQuantity != order.quantity) {
                        buyOrder.sold = true;
                        let precision = security.commonData.quantityScale ? getPrecision(security.commonData.quantityScale) : CRYPT2CRYPT_PRECISION;
                        buyOrder.quantity = (order.quantity * precision - order.remainingQuantity * precision) / precision;

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

async function getRankedList(provider, minLastPrice, minVolume, relationTo) {
    if (typeof provider == 'string') {
        provider = proxy(provider)();
    }
    let list = await provider.getCurrentData(true, relationTo);
    if (!Array.isArray(list)) {
        return false;
    }

    for (let ticker of list) {
        ticker.rank = getRank(ticker);
    }

    if (minLastPrice > 0) {
        list = list.filter((item) => { return item.last >= minLastPrice });
    }

    if (minVolume > 0) {
        list = list.filter((item) => { return item.volume >= minVolume });
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
        let rankedList = await getRankedList('Binance', MIN_LAST_PRICE, MIN_VOLUME, 'BTC');
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

            let currencyName = security.getTicker().split('/')[0];
            //let currencyBalance = await provider.getBalance(currencyName);

            /*await closeOrders(security, 'OPEN');
            await closeOrders(security, 'PARTIALLY');
            await closeOrders(security, 'CLOSED');*/
            await closeOrders(security, 'NOT_CANCELLED');
        }

        for (let security of allSecurities) {
            let provider = security.provider;

            await security.init();

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

                let ask = Math.floor((min_ask - (1 / precision)) * precision) / precision;
                
                if (ask >= (order.price * FIX_PROFIT * precision) / precision || order.boughtTime + FIX_LOSS_TIME <= Date.now()) {
                    let response = await provider.sellLimit(ask, +order.quantity.toFixed(priceScale));

                    if (!response) {
                        console.warn('Unable to sellLimit, price', ask, 'quantity', order.quantity, 'response', response, 'order', order);
                    } else {
                        console.log(security.getTicker(), 'sellLimit, price', ask, 'quantity', order.quantity);
                        if (order.boughtTime + FIX_LOSS_TIME <= Date.now()) {
                            console.log(security.getTicker(), 'fix loss');
                        }
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

                if (fullBalance * SAFE_RELATION_TO_TOTAL_BALANCE < btcBalance && currencyBalance === 0 && security.buyOrders.filter((item) => { return !item.sold }).length < MAX_OPENED_ORDERS ) {
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
                            security.buyOrders = security.buyOrders || [];
                            security.buyOrders.push(createBuyOrder(response.orderId, Date.now(), bid, quantity));
                        }
                        
                    }
                }
            }

            security.save();
        }

    } catch (err) {
        console.log(err);
    }
}

let intervalId = null;
module.exports.index = async function(req, res, next) {
    if (!intervalId) {
        tickBot();
        intervalId = setInterval(tickBot, 5 * 60 * 1000);
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