'use strict';

const { messagingApi } = require('@line/bot-sdk');
const { config } = require('./config');

const client = new messagingApi.MessagingApiClient({
  channelAccessToken: config.line.channelAccessToken,
});

const reply = (replyToken, messages) =>
  client.replyMessage({
    replyToken,
    messages: Array.isArray(messages) ? messages : [messages],
  });

const push = (to, messages) =>
  client.pushMessage({
    to,
    messages: Array.isArray(messages) ? messages : [messages],
  });

module.exports = { client, reply, push };
