import Discord, { ActivityType } from 'discord.js';
import { binanceClient } from '.';
import Binance, {
  FuturesAccountPosition,
  FuturesUserTradeResult,
  NewFuturesOrder,
  OrderSide_LT,
} from 'binance-api-node';
import axios from 'axios';
import moment from 'moment';


const discordWebhookEndpoint = process.env.DISCORD_WEBHOOK || '';
const currency = process.env.CURRENCY;
const tradePair = process.env.TRADE_PAIR;

const sendNotifications = (message: string) => {
  try {
    axios.post(discordWebhookEndpoint, {
      content: `${'```'}${message}${'```'}`,
    });
  } catch (error) {
    console.log(error);
  }
};

// const prisma = new PrismaClient();
const countDecimals = (num: number) => {
  if (Math.floor(num) === num) return 0;
  return num.toString().split('.')[1].length || 0;
};

const convertToPrecision = (num: number, precision: number) => {
  return Math.trunc(num * Math.pow(10, precision)) / Math.pow(10, precision);
};


const checkConnection = () => {
  return binanceClient.ping();
};

const currentPositions = async () => {
  const accountInfo = await binanceClient.futuresAccountInfo();

  const positions = accountInfo.positions.filter(
    (item) =>
      parseFloat(item.entryPrice) > 0 && item.symbol === process.env.TRADE_PAIR
  );
  return positions;
};

const entry = async (
  symbol: string,
  risk: number,
  entryPrice: string,
  side: OrderSide_LT,
  stoplossPrice: string,
  takeProfitPrice: string,
  partialProfits: {
    where: number;
    qty: number;
  }[]
) => {
  /* no entry on current position */
  const positions = await currentPositions();

  if (positions.length > 0) {
    console.log('Cancelled opening position');
    throw new Error('Currently in a trade.');
  }

  const balances = await binanceClient.futuresAccountBalance();

  const balance = balances.find((item) => item.asset === process.env.CURRENCY);

  /* get precisions */
  const info = await binanceClient.futuresExchangeInfo();

  const symbolInfo = info.symbols.find((item) => item.symbol === symbol);

  const { pricePrecision, quantityPrecision } =
    symbolInfo as unknown as Symbol & {
      pricePrecision: number;
      quantityPrecision: number;
    };

  if (!symbolInfo)
    throw new Error('symbol info is undefined')

  console.log({ symbolInfo });

  const priceFilter = symbolInfo.filters.find(
    (item) => item.filterType === 'PRICE_FILTER'
  );

  const tickSize = countDecimals(
    parseFloat((priceFilter as any).tickSize as string)
  );

  console.log(symbolInfo.filters);
  console.log({ tickSize });

  if (!balance)
    throw new Error('balance is undefined.')

  const trade = await binanceClient.futuresTrades({ symbol: symbol, limit: 1 });

  // calculate qty from risk $ amount
  // get stoploss in a percent
  const stoploss = Math.abs(parseFloat(entryPrice) - parseFloat(stoplossPrice)) / parseFloat(entryPrice)

  const amount = ((parseFloat(balance.balance) * risk) / stoploss)

  const qty = convertToPrecision(amount / parseFloat(trade[0].price), quantityPrecision)

  console.log({ leverage: amount / parseFloat(balance.availableBalance) })

  const setLeverage = Math.round((amount / parseFloat(balance.availableBalance) + 1))

  console.log({ setLeverage, qty })


  const leverage = await binanceClient.futuresLeverage({
    symbol: symbol,
    leverage: setLeverage,
  });



  console.log({
    qty,
    balance: balance.balance,
    leverage: leverage.leverage,
    price: trade[0].price,
    quantityPrecision,
  });

  const entryOrder: NewFuturesOrder = {
    symbol: symbol,
    type: 'MARKET',
    side: side,
    quantity: `${qty}`,
  };

  // entry
  let origQty: number = 0;
  try {

    const executedEntryOrder = await binanceClient.futuresOrder(entryOrder);

    console.log('ENTRY');
    console.log({ entry: executedEntryOrder });
    console.log('-----');

    origQty = parseFloat(executedEntryOrder.origQty);

    sendNotifications(
      `Entry ${symbol} Leverage: ${setLeverage}, Side: ${side}, Price: ${executedEntryOrder.price
      },  PartialProfits: ${JSON.stringify(partialProfits)}`
    );

  } catch (error) {
    console.error(error);
    sendNotifications((error as unknown as any)?.message);
  }

  // stoploss
  let currentPosition: FuturesAccountPosition | undefined = undefined;
  try {
    while (currentPosition === undefined)
      currentPosition = await getPosition(symbol);
  } catch (error) {
    console.error(error);
    sendNotifications((error as unknown as any)?.message);
  }

  let price = parseFloat(stoplossPrice)

  if (!currentPosition)
    throw new Error('currentPosition position is undefined.')

  const currentQty = Math.abs(parseFloat(currentPosition.positionAmt));

  const stopLossOrder: NewFuturesOrder = {
    symbol: symbol,
    stopPrice: convertToPrecision(price, tickSize) as any,
    closePosition: 'true',
    type: 'STOP_MARKET',
    side: side === 'BUY' ? 'SELL' : 'BUY',
    quantity: `${currentQty}`,
    workingType: 'CONTRACT_PRICE',
  };
  try {
    const executedStopLossOrder = await binanceClient.futuresOrder(
      stopLossOrder
    );

    // sendNotifications('STOPLOSS');
    // sendNotifications(JSON.stringify(executedStopLossOrder));
    // sendNotifications('--------');

    console.log('STOPLOSS');
    console.log({ executedStopLossOrder });
    console.log('--------');
  } catch (error) {
    console.error(error);
    sendNotifications((error as unknown as any)?.message);
  }

  // takeprofit

  // set take_profit order
  price = parseFloat(takeProfitPrice);

  const takeProfitOrder: NewFuturesOrder = {
    symbol: symbol,
    stopPrice: convertToPrecision(price, tickSize) as any,
    closePosition: 'true',
    type: 'TAKE_PROFIT_MARKET',
    side: side === 'BUY' ? 'SELL' : 'BUY',
    quantity: `${currentQty}`,
  };

  try {
    const executedTakeProfitOrder = await binanceClient.futuresOrder(
      takeProfitOrder
    );
    console.log({ executedTakeProfitOrder });
  } catch (error) {
    console.error(error);
  }

  const previousQtys: number[] = [];
  partialProfits.forEach(async (item) => {


    const price = parseFloat(entryPrice) + ((side === 'BUY' ? parseFloat(takeProfitPrice) : -parseFloat(takeProfitPrice)) - parseFloat(entryPrice)) * item.where;



    let qty = convertToPrecision(currentQty * item.qty, quantityPrecision);

    if (item.where === 1) {
      /* to remove any left size in open orders */
      qty = convertToPrecision(
        origQty - previousQtys.reduce((acc, cur) => acc + cur, 0),
        quantityPrecision
      );
    } else {
      previousQtys.push(qty);
    }

    console.log({
      price,
      qty,
      converted: convertToPrecision(price, pricePrecision),
    });

    const takeProfitOrder = {
      symbol: symbol,
      price: convertToPrecision(price, tickSize) as any,
      type: 'LIMIT',
      side: side === 'BUY' ? 'SELL' : 'BUY',
      quantity: `${qty}`,
    };

    try {
      const executedTakeProfitOrder = await binanceClient.futuresOrder(
        takeProfitOrder as any
      );
      // sendNotifications('TAKEPROFIT');
      // sendNotifications(JSON.stringify(executedTakeProfitOrder));
      // sendNotifications('--------');
      // console.log('TAKEPROFIT');
      console.log({ executedTakeProfitOrder });
      // console.log('--------');
    } catch (error) {
      console.error(error);
    }
  });
};

const setStoploss = async (
  symbol: string,
  type: 'profit_25' | 'profit_50' | 'profit_75',
  takeProfit: number,
  stopLoss: number,
  side: OrderSide_LT
) => {
  /* get precisions */
  const info = await binanceClient.futuresExchangeInfo();
  const symbolInfo = info.symbols.find((item) => item.symbol === symbol);

  if (!symbolInfo)
    throw new Error('symbolInfo is undefined.')

  const priceFilter = symbolInfo.filters.find(
    (item) => item.filterType === 'PRICE_FILTER'
  );
  const tickSize = countDecimals(
    parseFloat((priceFilter as any).tickSize as string)
  );

  const currentPosition = await getPosition(symbol);

  if (!currentPosition)
    throw new Error('currentPosition is undefined.')

  const currentQty = Math.abs(parseFloat(currentPosition.positionAmt));

  let price;
  // if (type === 'profit_25') {
  //   price =
  //     parseFloat(currentPosition.entryPrice) +
  //     parseFloat(currentPosition.entryPrice) *
  //       stopLoss *
  //       (side === 'SELL' ? -1 : 1) *
  //       0.5;
  // }
  if (type === 'profit_25') {
    price = parseFloat(currentPosition.entryPrice);
  }

  if (type === 'profit_50') {
    price =
      parseFloat(currentPosition.entryPrice) +
      parseFloat(currentPosition.entryPrice) *
      takeProfit *
      (side === 'SELL' ? 1 : -1) *
      0.25;
  }

  if (type === 'profit_75') {
    price =
      parseFloat(currentPosition.entryPrice) +
      parseFloat(currentPosition.entryPrice) *
      takeProfit *
      (side === 'SELL' ? 1 : -1) *
      0.5;
  }

  if (!price)
    throw new Error('price is undefined.')

  const stopLossOrder: NewFuturesOrder = {
    symbol: symbol,
    stopPrice: convertToPrecision(price, tickSize) as any,
    closePosition: 'true',
    type: 'STOP_MARKET',
    side: side,
    quantity: `${currentQty}`,
  };

  try {
    const executedStopLossOrder = await binanceClient.futuresOrder(
      stopLossOrder
    );
    sendNotifications(`MOVE STOPLOSS ${type}`);

    console.log('MOVE STOPLOSS');
    console.log({ executedStopLossOrder });
    console.log('--------');
    // sendNotifications(`Moving stoploss to entry ${symbol} Side: ${side}`);
  } catch (error) {
    console.error(error);
    sendNotifications((error as unknown as any)?.message);
  }
};

const getPosition = async (symbol: string) => {
  const positions = await currentPositions();

  return positions.find((item) => item.symbol === symbol) || undefined;
};

const getCurrentBalance = async (symbol: string) => {
  const balances = await binanceClient.futuresAccountBalance();
  const balance = balances.find((item) => item.asset === process.env.CURRENCY);
  return balance;
};

const getTradeHistory = async (symbol: string, limit: number) => {
  const trade = await binanceClient.futuresUserTrades({
    symbol,
    limit,
  });

  // console.log(trade);

  return trade.flatMap((each) => {
    if (parseFloat(each.realizedPnl) === 0) return [];

    return each;
  });
};

const updateBalance = async (client: Discord.Client) => {
  console.log('Update balance')


  // update discord bot status
  if (!currency)
    throw new Error('currency is undefined.')
  const balance = await getCurrentBalance(currency);

  if (!tradePair)
    throw new Error('tradePair is undefined.')

  const tradeHistory: FuturesUserTradeResult[] = await getTradeHistory(
    tradePair,
    1
  );

  let percent;

  if (!balance)
    throw new Error('balance is undefined.')


  if (parseFloat(balance.balance) > parseFloat(tradeHistory?.[0]?.realizedPnl || '0')) {
    percent =
      (parseFloat(tradeHistory?.[0]?.realizedPnl || '0') /
        (parseFloat(balance.balance) -
          parseFloat(tradeHistory?.[0]?.realizedPnl || '0'))) *
      100;
  } else {
    percent =
      (parseFloat(tradeHistory?.[0]?.realizedPnl || '0') /
        (parseFloat(balance.balance) +
          parseFloat(tradeHistory?.[0]?.realizedPnl || '0'))) *
      100;
  }


  client.user?.setPresence({
    activities: [{
      type: ActivityType.Watching,
      name: `$${parseFloat(balance.balance).toFixed(2)} (${percent > 0 ? '👍' : '👎'
        }${percent.toPrecision(2)}%)`,
    }],
  });
};

const getOpenOrders = async () => {
  const orders = await binanceClient.futuresOpenOrders({
    // symbol: (req.query?.pair as string) || 'BTCUSDT',
  });
  return orders;
};

const getPnl = async () => {
  const orders = await binanceClient.futuresIncome({
    symbol: process.env.TRADE_PAIR,
    startTime: moment().subtract(3, 'month').unix() * 1000,
    endTime: moment().unix() * 1000,
    limit: 1000,
    incomeType: 'REALIZED_PNL',
  });
  return orders;
};

const BinanceFunctions = {
  checkConnection,
  currentPositions,
  entry,
  getPnl,
  getPosition,
  sendNotifications,
  setStoploss,
  getCurrentBalance,
  getTradeHistory,
  updateBalance,
  getOpenOrders,
};

export default BinanceFunctions
