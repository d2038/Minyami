const ReconnectingWebSocket = require("@eridanussora/reconnecting-websocket");
const WebSocket = require("ws");
import Axios from "axios";
import { SocksProxyAgent } from "socks-proxy-agent";
import UA from "../../constants/ua";
import logger from "../../utils/log";
import ProxyAgentHelper from "../../utils/agent";
import { isChunkGroup, ChunkGroup } from "../downloader";
import { ParserOptions, ParserResult } from "./types";

export default class Parser {
    static updateToken(token: string, downloader: ParserOptions["downloader"], host = undefined) {
        logger.info(`Update Token: ${token}`);
        for (const chunk of downloader.allChunks) {
            if (isChunkGroup(chunk)) {
                for (const c of chunk.chunks) {
                    c.url = c.url.replace(/ht2_nicolive=([^\&]+)/, `ht2_nicolive=${token}`);
                    if (host) {
                        c.url = c.url.replace(/(http(s):\/\/.+\/)(\d\/ts)/, `${host}$3`);
                    }
                }
            } else {
                chunk.url = chunk.url.replace(/ht2_nicolive=([^\&]+)/, `ht2_nicolive=${token}`);
                if (host) {
                    chunk.url = chunk.url.replace(/(http(s):\/\/.+\/)(\d\/ts)/, `${host}$3`);
                }
            }
        }
        for (const chunk of downloader.chunks) {
            if (isChunkGroup(chunk)) {
                chunk.actions.forEach((action) => {
                    if (action.actionName === "ping") {
                        action.actionParams = action.actionParams.replace(
                            /ht2_nicolive=([^\&]+)/,
                            `ht2_nicolive=${token}`
                        );
                        if (host) {
                            action.actionParams = action.actionParams.replace(/(http(s):\/\/.+\/)/gi, host);
                        }
                    }
                });
                for (const c of chunk.chunks) {
                    c.url = c.url.replace(/ht2_nicolive=([^\&]+)/, `ht2_nicolive=${token}`);
                    if (host) {
                        c.url = c.url.replace(/(http(s):\/\/.+\/)(\d\/ts)/, `${host}$3`);
                    }
                }
            } else {
                chunk.url = chunk.url.replace(/ht2_nicolive=([^\&]+)/, `ht2_nicolive=${token}`);
                if (host) {
                    chunk.url = chunk.url.replace(/(http(s):\/\/.+\/)(\d\/ts)/, `${host}$3`);
                }
                if (chunk.parentGroup) {
                    chunk.parentGroup.actions.forEach((action) => {
                        if (action.actionName === "ping") {
                            action.actionParams = action.actionParams.replace(
                                /ht2_nicolive=([^\&]+)/,
                                `ht2_nicolive=${token}`
                            );
                            if (host) {
                                action.actionParams = action.actionParams.replace(/(http(s):\/\/.+\/)/gi, host);
                            }
                        }
                    });
                }
            }
        }
    }
    static parse({ downloader }: ParserOptions): ParserResult {
        if (!downloader.m3u8.m3u8Url) {
            throw new Error("Missing m3u8 url for Niconico.");
        }
        const proxyAgent = ProxyAgentHelper.getProxyAgentInstance();
        if (downloader.key) {
            // NICO Enhanced mode ON!
            logger.info(`Enhanced mode for Nico-TS enabled`);
            if (downloader.key.includes("CAS_MODE")) {
                // 试验放送
                const liveId: string = downloader.key.match(/(lv\d+)/)[1];
                const getNewToken = async (): Promise<string | null> => {
                    const tokenServer = `https://api.cas.nicovideo.jp/v1/services/live/programs/${liveId}/watching-archive`;
                    try {
                        const response = await Axios.post(
                            tokenServer,
                            {
                                actionTrackId: "f9c2ff58de_1547108086372",
                                streamProtocol: "https",
                                streamQuality: "ultrahigh",
                                streamCapacity: "ultrahigh",
                            },
                            {
                                responseType: "json",
                                headers: {
                                    "X-Frontend-Id": "91",
                                    "X-Connection-Environment": "ethernet",
                                    "Content-Type": "application/json",
                                    Cookie: downloader.cookies,
                                    "User-Agent": UA.CHROME_DEFAULT_UA,
                                },
                                httpsAgent: proxyAgent ? proxyAgent : undefined,
                            }
                        );
                        const token = response.data.data.streamServer.url.match(/ht2_nicolive=(.+)/)[1];
                        const host = response.data.data.streamServer.url.match(/(http(s):\/\/.+\/)/)[1];
                        Parser.updateToken(token, downloader, host);
                        return token;
                    } catch (e) {
                        logger.debug("Fail to get new token from cas server.");
                        return null;
                    }
                };
                const freshTokenInterval = setInterval(() => {
                    getNewToken();
                }, 80000 / downloader.threads);
                downloader.once("downloaded", () => {
                    clearInterval(freshTokenInterval);
                });
                downloader.once("finished", () => {
                    clearInterval(freshTokenInterval);
                });
            } else {
                // 旧生放送
                const liveId = downloader.key.match(/(.+?)_/)[1];
                const isChannelLive = !liveId.startsWith("lv");
                let socketUrl, socket;
                let listened = false;
                if (!isChannelLive) {
                    socketUrl = `wss://a.live2.nicovideo.jp/wsapi/v2/watch/${liveId}/timeshift?audience_token=${downloader.key}`;
                } else {
                    // Channel Live
                    socketUrl = `wss://a.live2.nicovideo.jp/unama/wsapi/v2/watch/${liveId}/timeshift?audience_token=${downloader.key}`;
                }
                if (downloader.proxy) {
                    socket = new ReconnectingWebSocket(socketUrl, undefined, {
                        WebSocket: WebSocket,
                        clientOptions: {
                            headers: {
                                "User-Agent": UA.CHROME_DEFAULT_UA,
                            },
                            agent: proxyAgent ? proxyAgent : undefined,
                        },
                    });
                } else {
                    socket = new ReconnectingWebSocket(socketUrl, undefined, {
                        WebSocket: WebSocket,
                        clientOptions: {
                            headers: {
                                "User-Agent": UA.CHROME_DEFAULT_UA,
                            },
                        },
                    });
                }
                if (listened === false) {
                    socket.addEventListener("message", (message: any) => {
                        listened = true;
                        const parsedMessage = JSON.parse(message.data);
                        // Send heartbeat packet to keep alive
                        if (parsedMessage.type === "ping") {
                            socket.send(
                                JSON.stringify({
                                    type: "pong",
                                })
                            );
                            socket.send(
                                JSON.stringify({
                                    type: "keepSeat",
                                })
                            );
                        }
                        if (parsedMessage.type === "stream") {
                            // Nico Live v2 API
                            const token = parsedMessage.data.uri.match(/ht2_nicolive=(.+)/)[1];
                            const host = parsedMessage.data.uri.match(/(http(s):\/\/.+\/)/)[1];
                            logger.info(`Update token: ${token}`);
                            Parser.updateToken(token, downloader, host);
                        }
                    });
                    socket.addEventListener("open", () => {
                        const payload = {
                            type: "startWatching",
                            data: {
                                stream: {
                                    quality: "super_high",
                                    protocol: "hls",
                                    latency: "low",
                                    chasePlay: false,
                                },
                                room: { protocol: "webSocket", commentable: true },
                                reconnect: false,
                            },
                        };
                        const freshTokenInterval = setInterval(() => {
                            socket.send(JSON.stringify(payload));
                        }, 50000 / downloader.threads);
                        downloader.once("downloaded", () => {
                            clearInterval(freshTokenInterval);
                        });
                        downloader.once("finished", () => {
                            clearInterval(freshTokenInterval);
                        });
                    });
                }
            }
        }
        const prefix = downloader.m3u8.m3u8Url.match(/^(.+\/)/)[1];
        if (downloader) {
            if (downloader.chunks.length === 0) {
                // 生成 Fake M3U8
                const chunkLength = downloader.m3u8.getChunkLength();
                const videoLength = parseFloat(downloader.m3u8.m3u8Content.match(/#DMC-STREAM-DURATION:(.+)/)[1]);
                const firstChunkFilename = downloader.m3u8.chunks[0].url.match(/^(.+ts)/)[1];
                let offset;
                if (firstChunkFilename === "0.ts") {
                    offset = downloader.m3u8.chunks[1].url.match(/(\d{3})\.ts/)[1];
                } else {
                    offset = downloader.m3u8.chunks[0].url.match(/(\d{3})\.ts/)[1];
                }
                const suffix = downloader.m3u8.chunks[0].url.match(/\.ts(.+)/)[1];
                const newChunkList = [];
                let counter: number = 0;
                let chunkGroup: ChunkGroup = {
                    chunks: [],
                    isFinished: false,
                    isNew: true,
                };
                let startTime;
                for (let time = 0; time < videoLength; time += chunkLength) {
                    if (counter === 0) {
                        startTime = time.toString();
                        const pingUrl = downloader.m3u8Path.replace(/start=\d+/gi, `start=${startTime}`);
                        chunkGroup = {
                            actions: [
                                {
                                    actionName: "ping",
                                    actionParams: pingUrl.replace("1/ts/playlist.m3u8", "master.m3u8"),
                                },
                            ],
                            chunks: [],
                            isFinished: false,
                            isNew: true,
                        };
                    }
                    if (videoLength - parseFloat(`${time.toString()}.${offset}`) < 1) {
                        // 最后一块小于1秒 可能不存在
                        continue;
                    }
                    chunkGroup.chunks.push({
                        url:
                            prefix +
                            (time.toString() === "0"
                                ? `0.ts${suffix.replace(/start=.+&/gi, `start=${0}&`)}`
                                : `${time.toString()}${offset}.ts${suffix.replace(
                                      /start=.+&/gi,
                                      `start=${startTime}&`
                                  )}`),
                        filename: `${time.toString()}${offset}.ts`,
                    });
                    counter++;
                    if (counter === 4) {
                        newChunkList.push(chunkGroup);
                        counter = 0;
                    }
                }
                if (counter !== 0) {
                    newChunkList.push(chunkGroup);
                    counter = 0;
                }
                downloader.chunks = newChunkList;
            } else {
                // 刷新 Token
                const token = downloader.m3u8Path.match(/ht2_nicolive=(.+?)&/)[1];
                Parser.updateToken(token, downloader);
            }
        }
        return {};
    }
}
