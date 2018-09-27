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
const TOTAL_BALANCE = 0.00263;//17.55522361;
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

async function closeOrders(security, orderType) {
    let provider = security.provider;
    let openOrderResponse = await provider.getOrders(orderType);
    if (openOrderResponse && openOrderResponse.data) {
        for (let order of openOrderResponse.data) {
            if (/*order.type == 'MARKET_BUY' &&*/order.orderStatus == 'EXECUTED' || +(new Date(order.issueTime)) + MAX_ORDER_TIME < Date.now()) {
                if (order.orderStatus == 'PARTIALLY_FILLED_AND_CANCELLED' || order.orderStatus == 'EXECUTED' || await provider.cancelLimit(order.id)) {
                    if (order.type == "LIMIT_SELL") {
                        security.buyOrders = security.buyOrders || [];
                        let buyOrder = security.buyOrders.filter((item) => { return item.sellOrderId == order.id });
                        if (buyOrder.length != 1) {
                            console.warn('Can\'t find buyOrder or it\'s more than 1 with sellOrderId', order.id);
                        } else {
                            buyOrder = buyOrder[0];
                            if (buyOrder.sold) {
                                continue;
                            }
                            buyOrder.sellInProgress = false;
                            if (order.remainingQuantity != order.quantity) {
                                buyOrder.sold = true;
                                buyOrder.quantity = (order.quantity * CRYPT2CRYPT_PRECISION - order.remainingQuantity * CRYPT2CRYPT_PRECISION) / CRYPT2CRYPT_PRECISION;

                                if (order.remainingQuantity > 0) {
                                    let partOrder = createBuyOrder(buyOrder.orderId, buyOrder.issueTime, buyOrder.price, order.remainingQuantity);
                                    security.buyOrders.push(partOrder);
                                }
                            } else {
                                delete buyOrder['sellPrice'];
                            }
                        }
                    } else if (order.type == "LIMIT_BUY") {
                        security.buyOrders = security.buyOrders || [];
                        let buyOrder = security.buyOrders.filter((item) => { return item.orderId == order.id });
                        if (buyOrder.bought) {
                            continue;
                        }
                        if (buyOrder.length != 1) {
                            console.warn('Can\'t find buyOrder or it\'s more than 1 with orderId', order.id);
                        } else {
                            buyOrder = buyOrder[0];
                            if (order.remainingQuantity != order.quantity) {
                                buyOrder.bought = true;
                                buyOrder.quantity = Math.floor(order.quantity * CRYPT2CRYPT_PRECISION - order.remainingQuantity * CRYPT2CRYPT_PRECISION) / CRYPT2CRYPT_PRECISION;
                                buyOrder.boughtTime = Date.now();
                            } else {
                                security.buyOrders = security.buyOrders.filter((item) => { return item.orderId != order.id });
                            }
                        }
                    }
                } else {
                    console.warn('Unable to cancelLimit, id', order.id);
                }
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
    let list = await provider.getCurrentData(true);
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

        let fullRankedList = await getRankedList('LiveCoin', false, false, 'BTC');
        let rankedList = await getRankedList('LiveCoin', MIN_LAST_PRICE, MIN_VOLUME, 'BTC');
        if (Array.isArray(rankedList)) {
            console.log('Ranked list', rankedList.map((item) => { return { ticker: item.ticker, rank: item.rank } }));
        } else {
            rankedList = [];
        }

        for (let item of rankedList) {
            let security = new Security(item.ticker, { provider: 'LiveCoin' });
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

            let security = new Security(item.ticker, { provider: 'LiveCoin' });
            security.load();

            if (security.buyOrders && security.buyOrders.filter((item) => { return !item.sold }).length) {
                allSecurities.push(security);
            }
        }

        for (let security of allSecurities) {
            let provider = security.provider;

            let currencyName = security.getTicker().split('/')[0];
            let currencyBalance = await provider.getBalance(currencyName);

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
            let minLimitQuantity = security.commonData.minLimitQuantity;
            if (!priceScale) {
                console.warn(security.ticker, 'unable to load priceScale, skip this pair');
                continue;
            }
            let precision = 1;
            for (let i = 0; i < priceScale; ++i) {
                precision *= 10;
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

                if (fullBalance * SAFE_RELATION_TO_TOTAL_BALANCE < btcBalance && currencyBalance == 0 && security.buyOrders.filter((item) => { return !item.sold }).length < MAX_OPENED_ORDERS ) {
                    let availableBalance = Math.min(btcBalance - (fullBalance * SAFE_RELATION_TO_TOTAL_BALANCE), fullBalance / RELATION_TO_TOTAL_BALANCE);
                    let bid = Math.floor((max_bid + (1 / precision)) * precision) / precision;
                    let quantity = Math.floor((availableBalance / bid) * CRYPT2CRYPT_PRECISION) / CRYPT2CRYPT_PRECISION;
                    if (quantity >= minLimitQuantity) {

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