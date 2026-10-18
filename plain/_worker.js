/**
 * Cloudflare Worker 内核 —— 精简版（core-only）明文化版本
 *
 * 来源：byJoey/cfnew 分支 core-only 的发布产物 _worker.js（版本 2026.10.17.2）
 * 处理：仅格式化 + 按语义重命名标识符 + 加注释，未改动任何逻辑。
 * 校验：与原始压缩内核 AST alpha 等价，并通过 cfnew-panel 全部测试。
 *
 * 配套面板：https://cfnew.xy.kg/  （源码 byJoey/cfnew-panel）
 * 接口约定（面板调用）：/{UUID 或自定义路径}/api/config、/api/preferred-ips、/region、/test-api，
 * 以及根路径 "hello"。改动本文件时请保持这些路径与字段不变。
 *
 * 闭包内的短名状态变量（k/N/$/M/F 等）保留上游原名，方便与压缩版逐行对照。
 */
import { connect as cloudflareConnect } from "cloudflare:sockets";
//内核版本号：面板据此判断是否需要提示更新，必须与面板发布版本一致。
//env → KV 配置缓存的弱映射（30 秒），避免每个请求都读 KV。
//SHA-256 结果缓存（上限 32 条），用于 Trojan 密码哈希。
//所有 JSON 响应用到的 CORS 头。
const CORE_VERSION = "2026.10.17.2",
  kvConfigCache = new WeakMap(),
  sha256Cache = new Map(),
  CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Expose-Headers": "X-ECH-Status, X-ECH-Config-Length",
    "Access-Control-Max-Age": "86400"
  };
/*统一 JSON 响应：附带 CORS 头并禁止缓存。*/
function jsonResponse(A, R = 200) {
  return new Response(JSON.stringify(A), {
    status: R,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}
/*给已有 Response 补 CORS 头（透传 body/status）。*/
function withCorsHeaders(A) {
  const R = new Headers(A.headers);
  for (const [C, k] of Object.entries(CORS_HEADERS)) R.set(C, k);
  return R.set("Cache-Control", "no-store"), new Response(A.body, {
    status: A.status,
    headers: R
  });
}
/*读取 KV 中的配置（键 c）；force=true 时跳过缓存（配置保存后立即回读）。*/
async function readKvConfigCached(A, R = !1) {
  if (!A) return {};
  const C = kvConfigCache.get(A);
  if (!R && C && Date.now() - C.time < 3e4) return {
    ...(await C.value)
  };
  const k = A.get("c", "json").then(N => N || {});
  kvConfigCache.set(A, {
    time: Date.now(),
    value: k
  });
  try {
    return {
      ...(await k)
    };
  } catch (N) {
    throw kvConfigCache.delete(A), N;
  }
}
//Worker 模块入口，所有异常收敛为 502 JSON。
var workerModule = {
  async fetch(A, R = {}, C) {
    try {
      return await createRequestHandler(R)(A, R, C);
    } catch {
      return jsonResponse({
        error: "请求处理失败"
      }, 502);
    }
  }
};
/*Free CPU 保护：单连接累计 384 KiB 或 96 个数据块后主动断开，让客户端重连。*/
function createFreeCpuGuard(A) {
  let R = 0,
    C = 0,
    k = !1;
  const N = new Set(),
    $ = new Error("Free 保护：连接预算已用完");
  return $.code = "FREE_CPU_BUDGET", {
    enabled: A,
    get exhausted() {
      return k;
    },
    onExhausted(I) {
      N.add(I), k && I();
    },
    consume(I) {
      if (A) {
        if (k) throw $;
        if (!Number.isSafeInteger(I) || I < 0 || R + I > 384 * 1024 || C >= 96) {
          k = !0;
          for (const _ of N) try {
            _();
          } catch {}
          throw N.clear(), $;
        }
        R += I, C++;
      }
    }
  };
}
/*根据 env 构造请求处理器；env 的别名解析与配置快照都在这里完成。*/
function createRequestHandler(A) {
  const R = new TextDecoder();
  /*解码 base64 默认值（仅用于内联默认配置，不是加密）。*/
  function decodeBase64Text(e) {
    const n = atob(e),
      t = new Uint8Array(n.length);
    for (let r = 0; r < n.length; r++) t[r] = n.charCodeAt(r);
    return R.decode(t);
  }
  let k = "351c9981-04b6-4103-aa4b-864aa9c91469",
    N = "",
    $ = "",
    I = [],
    _ = [],
    Q = !1,
    q = !1,
    yt = !1,
    wt = !1,
    ee = !0,
    J = "",
    B = "",
    gt = "",
    be = "",
    Re = !0,
    Ne = !1,
    Ie = !1,
    ce = "",
    Pe = !1,
    bt = "https://223.5.5.5/dns-query",
    mt = "cloudflare-ech.com",
    xt = "",
    Et = decodeBase64Text("aHR0cHM6Ly91cmwudjEubWsvc3Vi"),
    Ut = !0,
    Ct = !0,
    St = !0,
    Lt = !1,
    Tt = !1,
    D = null,
    M = {},
    vt = 0,
    kt = "",
    v = createFreeCpuGuard(!1);
  const F = {
    freeCpu: "no",
    wk: "",
    ev: "yes",
    et: "no",
    ex: "no",
    ech: "no",
    tp: "",
    customDNS: "https://223.5.5.5/dns-query",
    customECHDomain: "cloudflare-ech.com",
    alpn: "",
    d: "",
    p: "",
    yx: "",
    yxURL: "",
    s: "",
    homepage: "",
    scu: decodeBase64Text("aHR0cHM6Ly91cmwudjEubWsvc3Vi"),
    ena: "no",
    epd: "yes",
    epi: "yes",
    egi: "yes",
    ae: "",
    rm: "",
    qj: "",
    dkby: "no",
    yxby: "",
    ipv4: "yes",
    ipv6: "yes",
    ispMobile: "yes",
    ispUnicom: "yes",
    ispTelecom: "yes",
    jk: "no"
  };
  /*把 env / KV 里的字符串解析成布尔（yes/no、true/false、1/0）。*/
  function parseBooleanFlag(e, n = !1) {
    if (e == null || e === "") return n;
    if (e === !0 || e === !1) return e;
    const t = String(e).trim().toLowerCase();
    return t === "yes" || t === "true" || t === "1" || t === "on" ? !0 : t === "no" || t === "false" || t === "0" || t === "off" ? !1 : n;
  }
  /*布尔转 yes/no，写回 config API 时保持字段格式。*/
  function yesNo(e, n = !1) {
    return parseBooleanFlag(e, n) ? "yes" : "no";
  }
  /*把 KV/环境变量的局部配置合并到默认值上，只取白名单字段。*/
  function mergeWithDefaults(e) {
    const n = {
      ...F,
      ...e
    };
    return ["freeCpu", "ev", "et", "ex", "ech", "ena", "epd", "epi", "egi", "ipv4", "ipv6", "ispMobile", "ispUnicom", "ispTelecom", "jk"].forEach(t => {
      n[t] = yesNo(n[t], parseBooleanFlag(F[t]));
    }), n.ev === "no" && n.et === "no" && n.ex === "no" && (n.ev = "yes"), n.ech === "yes" && (n.dkby = "yes"), n;
  }
  /*按顺序返回第一个非空值（用于 env 多别名）。*/
  function firstDefined(e, ...n) {
    if (e) {
      for (const t of n) if (e[t] !== void 0 && e[t] !== null && e[t] !== "") return e[t];
    }
  }
  /*把环境变量别名表（U/u、ET/et 等）映射成内部配置字段。*/
  function readEnvAliases(e = {}) {
    const n = {
        freeCpu: ["freeCpu", "FREE_CPU"],
        wk: ["wk", "WK"],
        ev: ["ev", "EV"],
        et: ["et", "ET"],
        ex: ["ex", "EX"],
        ech: ["ech", "ECH"],
        tp: ["tp", "TP"],
        customDNS: ["customDNS", "CUSTOMDNS", "CUSTOM_DNS"],
        customECHDomain: ["customECHDomain", "CUSTOMECHDOMAIN", "CUSTOM_ECH_DOMAIN"],
        alpn: ["alpn", "ALPN"],
        d: ["d", "D"],
        p: ["p", "P"],
        yx: ["yx", "YX"],
        yxURL: ["yxURL", "YXURL", "YX_URL"],
        s: ["s", "S"],
        homepage: ["homepage", "HOMEPAGE"],
        scu: ["scu", "SCU"],
        ena: ["ena", "ENA"],
        epd: ["epd", "EPD"],
        epi: ["epi", "EPI"],
        egi: ["egi", "EGI"],
        ae: ["ae", "AE"],
        rm: ["rm", "RM"],
        qj: ["qj", "QJ"],
        dkby: ["dkby", "DKBY"],
        yxby: ["yxby", "YXBY"],
        ipv4: ["ipv4", "IPV4"],
        ipv6: ["ipv6", "IPV6"],
        ispMobile: ["ispMobile", "ISPMOBILE", "ISP_MOBILE"],
        ispUnicom: ["ispUnicom", "ISPUNICOM", "ISP_UNICOM"],
        ispTelecom: ["ispTelecom", "ISPTELECOM", "ISP_TELECOM"],
        jk: ["jk", "JK"]
      },
      t = {};
    for (const [r, o] of Object.entries(n)) {
      const a = firstDefined(e, ...o);
      a !== void 0 && (t[r] = a);
    }
    return t;
  }
  /*最终生效配置 = 环境变量 + KV 覆盖。*/
  function effectiveConfig(e = A) {
    return mergeWithDefaults({
      ...readEnvAliases(e),
      ...M
    });
  }
  const Me = ["pp.xy.kg"];
  /*无可用优选地址时随机取一个官方域名兜底。*/
  function randomFallbackEndpoint() {
    return {
      domain: Me[Math.floor(Math.random() * Me.length)],
      region: "CF",
      regionCode: "CF",
      port: 443
    };
  }
  let Ve = [{
    domain: decodeBase64Text("UHJveHlJUC5ISy5DTUxpdXNzc3MubmV0"),
    region: "HK",
    regionCode: "HK",
    port: 443
  }, {
    domain: decodeBase64Text("UHJveHlJUC5VUy5DTUxpdXNzc3MubmV0"),
    region: "US",
    regionCode: "US",
    port: 443
  }, {
    domain: decodeBase64Text("UHJveHlJUC5TRy5DTUxpdXNzc3MubmV0"),
    region: "SG",
    regionCode: "SG",
    port: 443
  }, {
    domain: decodeBase64Text("UHJveHlJUC5KUC5DTUxpdXNzc3MubmV0"),
    region: "JP",
    regionCode: "JP",
    port: 443
  }, {
    domain: decodeBase64Text("UHJveHlJUC5LUi5DTUxpdXNzc3MubmV0"),
    region: "KR",
    regionCode: "KR",
    port: 443
  }, {
    domain: decodeBase64Text("UHJveHlJUC5ERS5DTUxpdXNzc3MubmV0"),
    region: "DE",
    regionCode: "DE",
    port: 443
  }, {
    domain: decodeBase64Text("UHJveHlJUC5TRS5DTUxpdXNzc3MubmV0"),
    region: "SE",
    regionCode: "SE",
    port: 443
  }, {
    domain: decodeBase64Text("UHJveHlJUC5OTC5DTUxpdXNzc3MubmV0"),
    region: "NL",
    regionCode: "NL",
    port: 443
  }, {
    domain: decodeBase64Text("UHJveHlJUC5GSS5DTUxpdXNzc3MubmV0"),
    region: "FI",
    regionCode: "FI",
    port: 443
  }, {
    domain: decodeBase64Text("UHJveHlJUC5HQi5DTUxpdXNzc3MubmV0"),
    region: "GB",
    regionCode: "GB",
    port: 443
  }, {
    domain: decodeBase64Text("UHJveHlJUC5PcmFjbGUuY21saXVzc3NzLm5ldA=="),
    region: "Oracle",
    regionCode: "Oracle",
    port: 443
  }, {
    domain: decodeBase64Text("UHJveHlJUC5EaWdpdGFsT2NlYW4uQ01MaXVzc3NzLm5ldA=="),
    region: "DigitalOcean",
    regionCode: "DigitalOcean",
    port: 443
  }, {
    domain: decodeBase64Text("UHJveHlJUC5WdWx0ci5DTUxpdXNzc3MubmV0"),
    region: "Vultr",
    regionCode: "Vultr",
    port: 443
  }, {
    domain: decodeBase64Text("UHJveHlJUC5NdWx0YWNvbS5DTUxpdXNzc3MubmV0"),
    region: "Multacom",
    regionCode: "Multacom",
    port: 443
  }];
  const X = atob("aW52YWxpZCBkYXRh"),
    It = atob("aW52YWxpZCB1c2Vy"),
    Pt = atob("Y29tbWFuZCBpcyBub3Qgc3VwcG9ydGVk"),
    Dt = atob("VURQIHByb3h5IG9ubHkgZW5hYmxlIGZvciBETlMgd2hpY2ggaXMgcG9ydCA1Mw=="),
    Mt = atob("aW52YWxpZCBhZGRyZXNzVHlwZQ=="),
    Ot = atob("YWRkcmVzc1ZhbHVlIGlzIGVtcHR5"),
    Vt = atob("d2ViU29ja2V0LmVhZHlTdGF0ZSBpcyBub3Qgb3Blbg=="),
    te = atob("SW52YWxpZCBTT0NLUyBhZGRyZXNzIGZvcm1hdA=="),
    Jt = atob("bm8gYWNjZXB0YWJsZSBtZXRob2Rz"),
    jt = atob("c29ja3Mgc2VydmVyIG5lZWRzIGF1dGg="),
    Bt = atob("ZmFpbCB0byBhdXRoIHNvY2tzIHNlcnZlcg=="),
    Je = atob("ZmFpbCB0byBvcGVuIHNvY2tzIGNvbm5lY3Rpb24="),
    je = atob("ZmFpbCB0byBvcGVuIHByb3h5IHR1bm5lbA=="),
    me = atob("aW52YWxpZCBwcm94eSByZXNwb25zZQ=="),
    Be = atob("c29ja3M1Oi8v"),
    $e = atob("c29ja3M6Ly8="),
    Ge = atob("aHR0cDovLw=="),
    We = atob("aHR0cHM6Ly8="),
    $t = atob("Q09OTkVDVA=="),
    Gt = atob("IEhUVFAvMS4x"),
    Wt = atob("SG9zdDog"),
    _t = atob("UHJveHktQXV0aG9yaXphdGlvbjogQmFzaWMg"),
    Ft = atob("UHJveHktQ29ubmVjdGlvbjogS2VlcC1BbGl2ZQ=="),
    Xt = atob("VXNlci1BZ2VudDogTW96aWxsYS81LjA="),
    Z = atob("DQo="),
    Zt = atob("SFRUUC8="),
    _e = "p5",
    Fe = "pt",
    le = "pts";
  let ne = {},
    j = !1;
  const xe = 1,
    ue = 2,
    Ee = 3,
    z = 64 * 1024,
    zt = 32 * 1024,
    Yt = 512,
    Kt = 0,
    Qt = 16 * 1024,
    Xe = 256 * 1024,
    Ze = 2,
    qt = 3500,
    fe = new TextDecoder(),
    re = new Map();
  /*UUID 格式校验。*/
  function isUuid(e) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(e);
  }
  /*IPv4/IPv6 字面量校验。*/
  function isIpAddress(e) {
    return !!(/^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/.test(e) || /^(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/.test(e) || /^(?:[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{1,4}){0,6})?::(?:[0-9a-fA-F]{1,4})?$/.test(e));
  }
  /*ALPN 白名单归一化（h3 / h2 / http/1.1 及其组合）。*/
  function normalizeAlpn(e) {
    const n = ["", "h3", "h2", "http/1.1", "h3,h2", "h2,http/1.1", "h3,h2,http/1.1"],
      t = String(e || "").trim();
    return n.includes(t) ? t : "";
  }
  /*把当前配置写回 KV，并写入 c_ver 版本戳。*/
  async function persistConfig() {
    if (D) try {
      const e = JSON.stringify(M);
      await D.put("c", e);
      const n = String(Date.now());
      kt = n;
      try {
        await D.put("c_ver", n);
      } catch {}
      vt = Date.now();
    } catch (e) {
      throw e;
    }
  }
  /*读配置字段（带默认值）。*/
  function getConfigValue(e, n = "") {
    return M[e] !== void 0 ? M[e] : n;
  }
  /*写配置字段并立即持久化。*/
  async function setConfigValue(e, n) {
    M[e] = n, await persistConfig();
  }
  /*按地区挑选入口地址，避免落到邻居地区的边缘节点。*/
  async function pickEndpointByRegion(e = "", n = ee) {
    if (!e || e === "CF" || Ve.length === 0) return randomFallbackEndpoint();
    const t = Ve.map(o => ({
      ...o,
      available: !0
    }));
    if (n && e) {
      const o = sortEndpointsByRegion(e, t, n);
      if (o.length > 0) return o[0];
    }
    return t[0];
  }
  /*地区邻居表：命中不到本地区时按此顺序回退。*/
  function regionFallbackList(e) {
    return {
      US: ["SG", "JP", "KR"],
      SG: ["JP", "KR", "US"],
      JP: ["SG", "KR", "US"],
      KR: ["JP", "SG", "US"],
      DE: ["NL", "GB", "SE", "FI"],
      SE: ["DE", "NL", "FI", "GB"],
      NL: ["DE", "GB", "SE", "FI"],
      FI: ["SE", "DE", "NL", "GB"],
      GB: ["DE", "NL", "SE", "FI"]
    }[e] || [];
  }
  /*生成完整地区优先级序列。*/
  function regionPriority(e) {
    const n = regionFallbackList(e),
      t = ["US", "SG", "JP", "KR", "DE", "SE", "NL", "FI", "GB"];
    return [e, ...n, ...t.filter(r => r !== e && !n.includes(r))];
  }
  /*按地区优先级给候选地址排序。*/
  function sortEndpointsByRegion(e, n, t = ee) {
    if (!t || !e) return n;
    const r = regionPriority(e),
      o = [];
    for (const a of r) {
      const s = n.filter(u => u.regionCode === a);
      o.push(...s);
    }
    return o;
  }
  /*解析 host[:port]、[v6]:port 形式。*/
  function parseHostPort(e) {
    if (e.includes("[") && e.includes("]")) {
      const t = e.match(/^\[([^\]]+)\](?::(\d+))?$/);
      if (t) return {
        address: t[1],
        port: t[2] ? parseInt(t[2], 10) : null
      };
    }
    const n = e.lastIndexOf(":");
    if (n > 0) {
      const t = e.substring(0, n),
        r = e.substring(n + 1),
        o = parseInt(r, 10);
      if (!t.includes(":") && !isNaN(o) && o > 0 && o <= 65535) return {
        address: t,
        port: o
      };
    }
    return {
      address: e,
      port: null
    };
  }
  /*处理 WebSocket 升级：解析 VLESS / Trojan 首包后建立隧道。*/
  async function handleWebSocketUpgrade(e) {
    const n = new URL(e.url),
      t = n.searchParams.get("p") || "",
      r = (n.searchParams.get("wk") || "").toUpperCase(),
      o = n.searchParams.get("rm") || "",
      a = o ? o.toLowerCase() !== "no" : null,
      s = n.searchParams.get("s") || "";
    let u = null;
    if (s) try {
      u = parseOutboundSpec(s);
    } catch {}
    let f = J;
    !f || f === "" ? r ? f = r : B && B.trim() ? f = B.trim().toUpperCase() : f = "CF" : r && (f = r);
    const i = new WebSocketPair(),
      [h, l] = Object.values(i);
    l.accept(), l.binaryType = "arraybuffer";
    let c = {
        socket: null,
        writer: null,
        drainUpload: null
      },
      d = !1,
      p = null,
      g = !1,
      w = !1;
    const U = createUploadQueue(Qt, v.enabled ? 1024 * 1024 : Xe, v.enabled ? 128 : Xe >> 8),
      x = e.fetcher;
    function releaseWriter() {
      try {
        c.writer?.releaseLock();
      } catch {}
      c.writer = null;
    }
    function abortSession() {
      if (!w) {
        w = !0, U.clear(), releaseWriter();
        try {
          c.socket?.close();
        } catch {}
        try {
          l.close(v.exhausted ? 1e3 : 1011, v.exhausted ? "Free 保护：请重新连接" : "连接已结束");
        } catch {}
      }
    }
    v.onExhausted(abortSession), l.addEventListener("close", abortSession);
    function enqueueUpload(E) {
      const T = toUint8Array(E);
      return T.byteLength ? U.sow(T) ? (c.drainUpload(), !0) : (abortSession(), !1) : !0;
    }
    async function flushUpload() {
      if (!(g || w || !c.writer)) {
        g = !0;
        try {
          for (; !(w || !c.writer);) {
            const [E] = U.bundle();
            if (!E) break;
            await c.writer.write(E);
          }
        } catch {
          abortSession();
        } finally {
          g = !1, !U.empty && !w && c.writer && queueMicrotask(flushUpload);
        }
      }
    }
    c.drainUpload = () => {
      !g && !U.empty && c.writer && queueMicrotask(flushUpload);
    };
    const b = e.headers.get(atob("c2VjLXdlYnNvY2tldC1wcm90b2NvbA==")) || "";
    return createUploadStream(l, b).pipeTo(new WritableStream({
      async write(E) {
        if (w) return;
        const T = toUint8Array(E);
        if (d) return await dnsOverHttpsQuery(T, l, null, x);
        if (c.socket && c.writer) {
          if (!enqueueUpload(T)) throw new Error("upload queue overflow");
          return;
        }
        if (p) {
          if (!enqueueUpload(T)) throw new Error("upload queue overflow");
          return;
        }
        if (!p) {
          if (Re && T.byteLength >= 24) {
            const W = parseVlessHeader(T, k);
            if (!W.hasError) {
              p = decodeBase64Text("dmxlc3M=");
              const {
                addressType: ae,
                port: ge,
                hostname: ve,
                rawIndex: ke,
                version: Vn,
                isUDP: Jn
              } = W;
              if (Jn) if (ge === 53) d = !0;else throw new Error(Dt);
              const ft = new Uint8Array([Vn[0], 0]),
                dt = T.subarray(ke);
              if (d) return dnsOverHttpsQuery(dt, l, ft, x);
              await openTunnel(ae, ve, ge, dt, l, ft, c, t, f, a, u, x);
              return;
            }
          }
          if (Ne && T.byteLength >= 56) {
            const W = await parseTrojanHeader(T, k);
            if (!W.hasError) {
              p = atob("dHJvamFu");
              const {
                addressType: ae,
                port: ge,
                hostname: ve,
                rawClientData: ke
              } = W;
              await openTunnel(ae, ve, ge, ke, l, null, c, t, f, a, u, x);
              return;
            }
          }
          throw new Error("Invalid protocol or authentication failed");
        }
      }
    })).catch(E => {
      abortSession();
    }), new Response(null, {
      status: 101,
      webSocket: h
    });
  }
  /*建立到目标（或 ProxyIP / SOCKS5）的隧道，并双向转发数据。*/
  async function openTunnel(e, n, t, r, o, a, s, u = "", f = "", i = null, h = null, l = null) {
    const c = u || N,
      d = f || J,
      p = i !== null ? i : ee,
      g = h || ne,
      w = h ? !0 : j,
      U = toUint8Array(r);
    async function connectRemote(y, b, m = !1) {
      if (v.exhausted) throw new Error("Free 连接预算已用完");
      const E = m ? await dialProxy(e, y, b, g, l, U) : await raceConnect(y, b, l, Ze),
        T = E.writable.getWriter();
      return !m && U.byteLength && (await T.write(U)), {
        remoteSock: E,
        writer: T
      };
    }
    function detachSocket(y, b) {
      if (s.socket === y) {
        try {
          b?.releaseLock();
        } catch {}
        s.socket = null, s.writer = null;
      }
    }
    function handleRemoteClosed(y, b, m) {
      if (v.exhausted) {
        b.abort().catch(() => {});
        try {
          y.close();
        } catch {}
        return;
      }
      try {
        s.writer && s.writer !== b && s.writer.releaseLock();
      } catch {}
      s.socket = y, s.writer = b, s.drainUpload?.(), y.closed.catch(() => {}).finally(() => {
        s.socket === y && closeWebSocket(o);
      }), createDownloadStream(y, o, a, m).finally(() => {
        if (s.socket === y) {
          try {
            b.releaseLock();
          } catch {}
          s.writer = null;
        }
      });
    }
    async function bridgeRemoteToClient() {
      if (!v.exhausted) {
        if (q && w) {
          closeWebSocket(o);
          return;
        }
        if (Q && w) try {
          const {
            remoteSock: y,
            writer: b
          } = await connectRemote(n, t, !0);
          handleRemoteClosed(y, b, null);
          return;
        } catch {
          let b, m;
          if (c && c.trim()) {
            const E = parseHostPort(c);
            b = E.address, m = E.port || t;
          } else {
            const E = await pickEndpointByRegion(d, p);
            b = E ? E.domain : n, m = E ? E.port : t;
          }
          try {
            const {
              remoteSock: E,
              writer: T
            } = await connectRemote(b, m, !1);
            handleRemoteClosed(E, T, null);
          } catch {
            closeWebSocket(o);
          }
        } else {
          let y, b;
          if (c && c.trim()) {
            const m = parseHostPort(c);
            y = m.address, b = m.port || t;
          } else {
            const m = await pickEndpointByRegion(d, p);
            y = m ? m.domain : n, b = m ? m.port : t;
          }
          try {
            const {
              remoteSock: m,
              writer: E
            } = await connectRemote(y, b, w);
            handleRemoteClosed(m, E, null);
          } catch {
            closeWebSocket(o);
          }
        }
      }
    }
    try {
      const y = q && w ? !0 : Q ? !1 : w,
        {
          remoteSock: b,
          writer: m
        } = await connectRemote(n, t, y);
      handleRemoteClosed(b, m, () => {
        detachSocket(b, m), bridgeRemoteToClient();
      });
    } catch {
      await bridgeRemoteToClient();
    }
  }
  /*把各种二进制视图统一成 Uint8Array。*/
  function toUint8Array(e) {
    return e instanceof Uint8Array ? e : e instanceof ArrayBuffer ? new Uint8Array(e) : ArrayBuffer.isView(e) ? new Uint8Array(e.buffer, e.byteOffset, e.byteLength) : new Uint8Array(e);
  }
  /*拼接两个字节数组。*/
  function concatBytes(e, n) {
    const t = toUint8Array(e),
      r = toUint8Array(n),
      o = new Uint8Array(t.byteLength + r.byteLength);
    return o.set(t), o.set(r, t.byteLength), o;
  }
  /*上传缓冲队列：按块/字节上限排队，供远端写入。*/
  function createUploadQueue(e, n = e, t = Math.max(1, n >> 8)) {
    let r = [],
      o = 0,
      a = 0,
      s = null;
    function compactQueue() {
      o > 32 && o * 2 >= r.length && (r = r.slice(o), o = 0);
    }
    function shiftQueue() {
      if (o >= r.length) return null;
      const i = r[o];
      return r[o++] = void 0, a -= i.byteLength, compactQueue(), i;
    }
    return {
      get empty() {
        return o >= r.length;
      },
      clear() {
        r = [], o = 0, a = 0;
      },
      sow(i) {
        const h = i?.byteLength || 0;
        return h ? a + h > n || r.length - o >= t ? !1 : (r.push(i), a += h, !0) : !0;
      },
      bundle(i = null) {
        if (i ||= shiftQueue(), !i || o >= r.length || i.byteLength >= e) return [i, !1];
        let h = i.byteLength,
          l = o;
        for (; l < r.length;) {
          const p = r[l],
            g = h + p.byteLength;
          if (g > e) break;
          h = g, l++;
        }
        if (l === o) return [i, !1];
        const c = s ||= new Uint8Array(e);
        c.set(i);
        let d = i.byteLength;
        for (; o < l;) {
          const p = r[o];
          r[o++] = void 0, a -= p.byteLength, c.set(p, d), d += p.byteLength;
        }
        return compactQueue(), [c.subarray(0, h), !0];
      }
    };
  }
  /*WebSocket 批量发送器：攒够一定字节或超时后一次性 send。*/
  function createWebSocketSender(e) {
    const n = zt,
      t = Yt,
      r = Math.max(4096, t << 3);
    let o = new Uint8Array(n),
      a = 0,
      s = 0,
      u = !1,
      f = 0,
      i = 0,
      h = 0;
    function flushBuffer() {
      s && clearTimeout(s), s = 0, u = !1, a && (e.readyState === 1 && e.send(o.subarray(0, a).slice()), o = new Uint8Array(n), a = 0, h = 0);
    }
    function scheduleFlush() {
      s || u || (u = !0, i = f, queueMicrotask(() => {
        if (u = !1, !(!a || s)) {
          if (n - a < t) return flushBuffer();
          s = setTimeout(() => {
            if (s = 0, !!a) {
              if (n - a < t) return flushBuffer();
              if (h < 2 && (f !== i || a < r)) return h++, i = f, scheduleFlush();
              flushBuffer();
            }
          }, Math.max(Kt, 1));
        }
      }));
    }
    return {
      send(d) {
        const p = toUint8Array(d);
        let g = 0;
        const w = p.byteLength;
        if (w) for (; g < w;) {
          if (!a && w - g >= n) {
            const x = Math.min(n, w - g);
            e.readyState === 1 && e.send(g || x !== w ? p.subarray(g, g + x) : p), g += x;
            continue;
          }
          const U = Math.min(n - a, w - g);
          o.set(p.subarray(g, g + U), a), a += U, g += U, f++, a === n || n - a < t ? flushBuffer() : scheduleFlush();
        }
      },
      flush: flushBuffer
    };
  }
  /*直连 TCP/UDP（cloudflare:sockets）。*/
  function connectSocketRaw(e, n, t = null) {
    const r = {
      hostname: e,
      port: n
    };
    return t && typeof t.connect == "function" ? t.connect(r) : cloudflareConnect(r);
  }
  /*连接失败时回退到直接 connect。*/
  async function connectSocket(e, n, t = null) {
    try {
      const r = connectSocketRaw(e, n, t);
      return r?.opened && (await r.opened), r;
    } catch (r) {
      if (!t) throw r;
      const o = cloudflareConnect({
        hostname: e,
        port: n
      });
      return o?.opened && (await o.opened), o;
    }
  }
  /*并发竞速拨号，取最快建立的连接。*/
  async function raceConnect(e, n, t = null, r = 1) {
    const o = Math.max(1, r | 0);
    if (o <= 1) return connectSocket(e, n, t);
    const a = Array.from({
        length: o
      }, () => connectSocket(e, n, t)),
      s = await Promise.any(a);
    return a.forEach(u => {
      u.then(f => {
        if (f !== s) try {
          f.close();
        } catch {}
      }, () => {});
    }), s;
  }
  /*UUID 字符串转 16 字节。*/
  function uuidToBytes(e) {
    if (re.has(e)) return re.get(e);
    const n = String(e || "").replace(/-/g, "");
    if (n.length !== 32) return null;
    const t = new Uint8Array(16);
    for (let r = 0; r < 16; r++) {
      const o = Number.parseInt(n.slice(r * 2, r * 2 + 2), 16);
      if (Number.isNaN(o)) return null;
      t[r] = o;
    }
    return re.size > 16 && re.clear(), re.set(e, t), t;
  }
  /*校验 VLESS 首包里的 UUID 字节。*/
  function uuidBytesMatch(e, n, t) {
    const r = uuidToBytes(t);
    return !!r && e[n] === r[0] && e[n + 1] === r[1] && e[n + 2] === r[2] && e[n + 3] === r[3] && e[n + 4] === r[4] && e[n + 5] === r[5] && e[n + 6] === r[6] && e[n + 7] === r[7] && e[n + 8] === r[8] && e[n + 9] === r[9] && e[n + 10] === r[10] && e[n + 11] === r[11] && e[n + 12] === r[12] && e[n + 13] === r[13] && e[n + 14] === r[14] && e[n + 15] === r[15];
  }
  /*解析 VLESS 请求头（版本、UUID、附加信息、命令、目标地址）。*/
  function parseVlessHeader(e, n) {
    const t = toUint8Array(e);
    if (t.byteLength < 24) return {
      hasError: !0,
      message: X
    };
    const r = t.subarray(0, 1);
    if (!uuidBytesMatch(t, 1, n)) return {
      hasError: !0,
      message: It
    };
    const o = t[17],
      a = 18 + o;
    if (t.byteLength < a + 5) return {
      hasError: !0,
      message: X
    };
    const s = t[a];
    let u = !1;
    if (s !== 1) if (s === 2) u = !0;else return {
      hasError: !0,
      message: Pt
    };
    const f = 19 + o,
      i = t[f] << 8 | t[f + 1];
    let h = f + 2,
      l = 0,
      c = h + 1,
      d = "";
    const p = t[h];
    switch (p) {
      case xe:
        if (l = 4, t.byteLength < c + l) return {
          hasError: !0,
          message: X
        };
        d = `${t[c]}.${t[c + 1]}.${t[c + 2]}.${t[c + 3]}`;
        break;
      case ue:
        if (t.byteLength < c + 1) return {
          hasError: !0,
          message: X
        };
        if (l = t[c++], t.byteLength < c + l) return {
          hasError: !0,
          message: X
        };
        d = fe.decode(t.subarray(c, c + l));
        break;
      case Ee:
        if (l = 16, t.byteLength < c + l) return {
          hasError: !0,
          message: X
        };
        const g = [],
          w = new DataView(t.buffer, t.byteOffset + c, l);
        for (let U = 0; U < 8; U++) g.push(w.getUint16(U * 2).toString(16));
        d = g.join(":");
        break;
      default:
        return {
          hasError: !0,
          message: `${Mt}: ${p}`
        };
    }
    return d ? {
      hasError: !1,
      addressType: p,
      port: i,
      hostname: d,
      isUDP: u,
      rawIndex: c + l,
      version: r
    } : {
      hasError: !0,
      message: `${Ot}: ${p}`
    };
  }
  /*上传流：计费 Free 预算后写入远端。*/
  function createUploadStream(e, n) {
    let t = !1;
    return new ReadableStream({
      start(r) {
        function enqueueChunk(f) {
          if (!t) try {
            v.consume(f.byteLength), r.enqueue(toUint8Array(f));
          } catch (i) {
            t = !0;
            try {
              r.error(i);
            } catch {}
          }
        }
        const writeChunk = f => enqueueChunk(f.data);
        e.addEventListener("message", writeChunk), v.onExhausted(() => e.removeEventListener("message", writeChunk)), e.addEventListener("close", () => {
          t || (closeWebSocket(e), r.close());
        }), e.addEventListener("error", f => r.error(f));
        const {
          earlyData: s,
          error: u
        } = decodeEarlyDataHeader(n);
        u ? r.error(u) : s && enqueueChunk(s);
      },
      cancel() {
        t = !0, closeWebSocket(e);
      }
    });
  }
  /*下载流：从远端读回并计入 Free 预算。*/
  async function createDownloadStream(e, n, t, r) {
    let o = t,
      a = !1,
      s = !1,
      u = null;
    r && (u = setTimeout(() => {
      if (!a && !s) {
        s = !0;
        try {
          e.close && e.close();
        } catch {}
        r();
      }
    }, qt));
    const f = createWebSocketSender(n);
    let i = null,
      h = !0,
      l = new ArrayBuffer(z);
    try {
      try {
        i = e.readable.getReader({
          mode: "byob"
        });
      } catch {
        h = !1, i = e.readable.getReader();
      }
      for (;;) {
        const c = h ? await i.read(new Uint8Array(l, 0, z)) : await i.read();
        if (c.done) break;
        const d = c.value;
        v.consume(d.byteLength);
        let p = toUint8Array(d);
        const g = h && d?.buffer instanceof ArrayBuffer && d.buffer.byteLength >= z ? d.buffer : new ArrayBuffer(z);
        if (p.byteLength) {
          if (a || (a = !0, u && (clearTimeout(u), u = null)), n.readyState !== 1) throw new Error(Vt);
          o && (p = concatBytes(o, p), o = null), p.byteLength >= z >> 1 ? (f.flush(), n.send(p), h && (l = new ArrayBuffer(z))) : (f.send(p), h && (l = g));
        }
      }
      f.flush();
    } catch {
      s || closeWebSocket(n);
    } finally {
      try {
        f.flush();
      } catch {}
      try {
        i?.releaseLock();
      } catch {}
    }
    u && (clearTimeout(u), u = null), !a && !s && r && !v.exhausted && r();
  }
  /*DNS over HTTPS 查询（默认 223.5.5.5），用于 UDP:53 转发。*/
  async function dnsOverHttpsQuery(e, n, t, r = null) {
    try {
      const o = await raceConnect("8.8.4.4", 53, r, 1);
      v.onExhausted(() => {
        try {
          o.close();
        } catch {}
      });
      let a = t;
      const s = o.writable.getWriter();
      await s.write(e), s.releaseLock(), await createDownloadStream(o, n, a, null);
    } catch {}
  }
  /*出站拨号：直连、SOCKS5 或 HTTP(S) 代理。*/
  async function dialProxy(e, n, t, r = ne, o = null, a = null) {
    if (r && (r.kind === Fe || r.kind === le)) return dialSocks5(n, t, r, o, a);
    const {
        username: s,
        password: u,
        hostname: f,
        socksPort: i
      } = r,
      h = connectSocketRaw(f, i, o),
      l = h.writable.getWriter();
    await l.write(new Uint8Array(s ? [5, 2, 0, 2] : [5, 1, 0]));
    const c = h.readable.getReader();
    let d = new Uint8Array(0);
    async function readExact(b) {
      for (; d.length < b;) {
        const {
          value: m,
          done: E
        } = await c.read();
        if (E || !m) throw new Error(Je);
        d = concatBytes(d, m);
      }
      return d;
    }
    function takeBuffered(b) {
      const m = d.subarray(0, b);
      return d = d.subarray(b), m;
    }
    let w = await readExact(2);
    if (w[0] !== 5 || w[1] === 255) throw new Error(Jt);
    const U = w[1];
    if (takeBuffered(2), U === 2) {
      if (!s || !u) throw new Error(jt);
      const b = new TextEncoder(),
        m = new Uint8Array([1, s.length, ...b.encode(s), u.length, ...b.encode(u)]);
      if (await l.write(m), w = await readExact(2), w[0] !== 1 || w[1] !== 0) throw new Error(Bt);
      takeBuffered(2);
    }
    const S = new TextEncoder().encode(stripBrackets(n)),
      L = new Uint8Array([3, S.length, ...S]);
    if (await l.write(new Uint8Array([5, 1, 0, ...L, t >> 8, t & 255])), w = await readExact(4), w[1] !== 0) throw new Error(Je);
    const H = w[3];
    let y;
    if (H === 1) y = 10;else if (H === 4) y = 22;else if (H === 3) y = 7 + (await readExact(5))[4];else throw new Error(me);
    return await readExact(y), takeBuffered(y), a && a.byteLength && (await l.write(a)), l.releaseLock(), c.releaseLock(), d.length ? streamWithPrefix(h, d) : h;
  }
  /*去掉 IPv6 地址外面的方括号。*/
  function stripBrackets(e) {
    const n = String(e || "");
    return /^\[.*\]$/.test(n) ? n.slice(1, -1) : n;
  }
  /*SOCKS5 握手与 CONNECT。*/
  async function dialSocks5(e, n, t, r = null, o = null) {
    const {
        username: a,
        password: s,
        hostname: u,
        socksPort: f,
        kind: i
      } = t,
      h = i === le ? {
        secureTransport: "on",
        allowHalfOpen: !1
      } : void 0,
      l = {
        hostname: u,
        port: f
      },
      c = r && typeof r.connect == "function" ? h === void 0 ? r.connect(l) : r.connect(l, h) : cloudflareConnect(l, h);
    c?.opened && (await c.opened);
    const p = `${e.includes(":") && !/^\[.*\]$/.test(e) ? `[${e}]` : e}:${n}`;
    let g = `${$t} ${p}${Gt}${Z}${Wt}${p}${Z}${Xt}${Z}${Ft}${Z}`;
    a && (g += `${_t}${btoa(`${a}:${s || ""}`)}${Z}`), g += Z;
    const w = c.writable.getWriter(),
      U = c.readable.getReader();
    try {
      await w.write(new TextEncoder().encode(g));
      const x = [13, 10, 13, 10];
      let S = new Uint8Array(0),
        L = -1;
      for (; L < 0;) {
        const {
          value: m,
          done: E
        } = await U.read();
        if (E || !m) throw new Error(je);
        S = concatBytes(S, m);
        for (let T = 0; T + 3 < S.length; T++) if (S[T] === x[0] && S[T + 1] === x[1] && S[T + 2] === x[2] && S[T + 3] === x[3]) {
          L = T + 4;
          break;
        }
        if (L < 0 && S.length > 8192) throw new Error(me);
      }
      const H = fe.decode(S.subarray(0, Math.min(L, 128)));
      if (!H.startsWith(Zt)) throw new Error(me);
      const y = Number(H.split(" ")[1]);
      if (!(y >= 200 && y < 300)) throw new Error(je);
      const b = S.subarray(L);
      return o && o.byteLength && (await w.write(o)), w.releaseLock(), U.releaseLock(), b.byteLength ? streamWithPrefix(c, b) : c;
    } catch (x) {
      try {
        w.releaseLock();
      } catch {}
      try {
        U.releaseLock();
      } catch {}
      try {
        c.close();
      } catch {}
      throw x;
    }
  }
  /*给流加前缀（VLESS 响应的 2 字节头）。*/
  function streamWithPrefix(e, n) {
    let t = null;
    return {
      readable: new ReadableStream({
        start(o) {
          o.enqueue(n), t = e.readable.getReader();
        },
        async pull(o) {
          const {
            value: a,
            done: s
          } = await t.read();
          if (s) {
            o.close();
            return;
          }
          o.enqueue(a);
        },
        cancel(o) {
          try {
            t?.cancel(o);
          } catch {}
        }
      }),
      writable: e.writable,
      closed: e.closed,
      opened: e.opened,
      close: () => e.close()
    };
  }
  /*解析出站配置字符串（socks5://、http://、https://）。*/
  function parseOutboundSpec(e) {
    let n = String(e || "").trim(),
      t = _e;
    const r = n.toLowerCase();
    r.startsWith(We) ? (t = le, n = n.slice(We.length)) : r.startsWith(Ge) ? (t = Fe, n = n.slice(Ge.length)) : r.startsWith(Be) ? n = n.slice(Be.length) : r.startsWith($e) && (n = n.slice($e.length));
    const o = n.indexOf("/");
    if (o >= 0 && (n = n.slice(0, o)), !n) throw new Error(te);
    let [a, s] = n.split("@").reverse(),
      u,
      f,
      i,
      h;
    if (s) {
      const d = s.split(":");
      if (d.length !== 2) throw new Error(te);
      [u, f] = d;
    }
    const l = a.split(":"),
      c = l.pop();
    if (h = Number(c), isNaN(h)) {
      if (t === _e) throw new Error(te);
      l.push(c), h = t === le ? 443 : 80;
    }
    if (i = l.join(":"), !i) throw new Error(te);
    if (i.includes(":") && !/^\[.*\]$/.test(i)) throw new Error(te);
    return {
      username: u,
      password: f,
      hostname: i,
      socksPort: h,
      kind: t
    };
  }
  /*解析 Trojan 请求头并校验密码哈希。*/
  async function parseTrojanHeader(e, n) {
    const t = toUint8Array(e),
      o = await sha256(ce || n);
    if (t.byteLength < 56) return {
      hasError: !0,
      message: "invalid " + atob("dHJvamFu") + " data - too short"
    };
    let a = 56;
    if (t[56] !== 13 || t[57] !== 10) return {
      hasError: !0,
      message: "invalid " + atob("dHJvamFu") + " header format (missing CR LF)"
    };
    if (fe.decode(t.subarray(0, a)) !== o) return {
      hasError: !0,
      message: "invalid " + atob("dHJvamFu") + " password"
    };
    const u = t.subarray(a + 2);
    if (u.byteLength < 6) return {
      hasError: !0,
      message: atob("aW52YWxpZCBTT0NLUzUgcmVxdWVzdCBkYXRh")
    };
    const f = new DataView(u.buffer, u.byteOffset, u.byteLength);
    if (f.getUint8(0) !== 1) return {
      hasError: !0,
      message: "unsupported command, only TCP (CONNECT) is allowed"
    };
    const h = f.getUint8(1);
    let l = 0,
      c = 2,
      d = "";
    switch (h) {
      case 1:
        l = 4, d = u.subarray(c, c + l).join(".");
        break;
      case 3:
        l = u[c], c += 1, d = fe.decode(u.subarray(c, c + l));
        break;
      case 4:
        l = 16;
        const w = new DataView(u.buffer, u.byteOffset + c, l),
          U = [];
        for (let x = 0; x < 8; x++) U.push(w.getUint16(x * 2).toString(16));
        d = U.join(":");
        break;
      default:
        return {
          hasError: !0,
          message: `invalid addressType is ${h}`
        };
    }
    if (!d) return {
      hasError: !0,
      message: `address is empty, addressType is ${h}`
    };
    const p = c + l,
      g = new DataView(u.buffer, u.byteOffset + p, 2).getUint16(0);
    return {
      hasError: !1,
      addressRemote: d,
      addressType: h,
      port: g,
      hostname: d,
      rawClientData: u.subarray(p + 4)
    };
  }
  /*同步 SHA-256（带缓存）。*/
  async function sha256(e) {
    if (sha256Cache.has(e)) return sha256Cache.get(e);
    const t = new TextEncoder().encode(e),
      r = [1116352408, 1899447441, 3049323471, 3921009573, 961987163, 1508970993, 2453635748, 2870763221, 3624381080, 310598401, 607225278, 1426881987, 1925078388, 2162078206, 2614888103, 3248222580, 3835390401, 4022224774, 264347078, 604807628, 770255983, 1249150122, 1555081692, 1996064986, 2554220882, 2821834349, 2952996808, 3210313671, 3336571891, 3584528711, 113926993, 338241895, 666307205, 773529912, 1294757372, 1396182291, 1695183700, 1986661051, 2177026350, 2456956037, 2730485921, 2820302411, 3259730800, 3345764771, 3516065817, 3600352804, 4094571909, 275423344, 430227734, 506948616, 659060556, 883997877, 958139571, 1322822218, 1537002063, 1747873779, 1955562222, 2024104815, 2227730452, 2361852424, 2428436474, 2756734187, 3204031479, 3329325298];
    let o = [3238371032, 914150663, 812702999, 4144912697, 4290775857, 1750603025, 1694076839, 3204075428];
    const a = t.length,
      s = a * 8,
      u = Math.ceil((a + 9) / 64) * 64,
      f = new Uint8Array(u);
    f.set(t), f[a] = 128;
    const i = new DataView(f.buffer);
    i.setUint32(u - 4, s, !1);
    for (let c = 0; c < u; c += 64) {
      const d = new Uint32Array(64);
      for (let y = 0; y < 16; y++) d[y] = i.getUint32(c + y * 4, !1);
      for (let y = 16; y < 64; y++) {
        const b = rotateRight32(d[y - 15], 7) ^ rotateRight32(d[y - 15], 18) ^ d[y - 15] >>> 3,
          m = rotateRight32(d[y - 2], 17) ^ rotateRight32(d[y - 2], 19) ^ d[y - 2] >>> 10;
        d[y] = d[y - 16] + b + d[y - 7] + m >>> 0;
      }
      let [p, g, w, U, x, S, L, H] = o;
      for (let y = 0; y < 64; y++) {
        const b = rotateRight32(x, 6) ^ rotateRight32(x, 11) ^ rotateRight32(x, 25),
          m = x & S ^ ~x & L,
          E = H + b + m + r[y] + d[y] >>> 0,
          T = rotateRight32(p, 2) ^ rotateRight32(p, 13) ^ rotateRight32(p, 22),
          W = p & g ^ p & w ^ g & w,
          ae = T + W >>> 0;
        H = L, L = S, S = x, x = U + E >>> 0, U = w, w = g, g = p, p = E + ae >>> 0;
      }
      o[0] = o[0] + p >>> 0, o[1] = o[1] + g >>> 0, o[2] = o[2] + w >>> 0, o[3] = o[3] + U >>> 0, o[4] = o[4] + x >>> 0, o[5] = o[5] + S >>> 0, o[6] = o[6] + L >>> 0, o[7] = o[7] + H >>> 0;
    }
    const h = [];
    for (let c = 0; c < 7; c++) h.push((o[c] >>> 24 & 255).toString(16).padStart(2, "0"), (o[c] >>> 16 & 255).toString(16).padStart(2, "0"), (o[c] >>> 8 & 255).toString(16).padStart(2, "0"), (o[c] & 255).toString(16).padStart(2, "0"));
    const l = h.join("");
    return sha256Cache.size >= 32 && sha256Cache.delete(sha256Cache.keys().next().value), sha256Cache.set(e, l), l;
  }
  /*32 位循环右移。*/
  function rotateRight32(e, n) {
    return e >>> n | e << 32 - n;
  }
  let de = 0;
  const at = 128 * 1024,
    st = 45e3,
    gn = 32,
    bn = [13, 23, 28, 28, 28, 28, 28, 28, 28, 24, 30, 28, 28, 30, 28, 28, 28, 28, 28, 28, 28, 28, 30, 28, 28, 28, 28, 28, 28, 28, 28, 28, 6, 10, 10, 12, 13, 6, 8, 11, 10, 10, 8, 11, 8, 6, 6, 6, 5, 5, 5, 6, 6, 6, 6, 6, 6, 6, 7, 8, 15, 6, 12, 10, 13, 6, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 8, 7, 8, 13, 19, 13, 14, 6, 15, 5, 6, 5, 6, 5, 6, 6, 6, 5, 7, 7, 6, 6, 6, 5, 6, 7, 6, 5, 5, 6, 7, 7, 7, 7, 7, 15, 11, 14, 13, 28, 20, 22, 20, 20, 22, 22, 22, 23, 22, 23, 23, 23, 23, 23, 24, 23, 24, 24, 22, 23, 24, 23, 23, 23, 23, 21, 22, 23, 22, 23, 23, 24, 22, 21, 20, 22, 22, 23, 23, 21, 23, 22, 22, 24, 21, 22, 23, 23, 21, 21, 22, 21, 23, 22, 23, 23, 20, 22, 22, 22, 23, 22, 22, 23, 26, 26, 20, 19, 22, 23, 22, 25, 26, 26, 26, 27, 27, 26, 24, 25, 19, 21, 26, 27, 27, 26, 27, 24, 21, 21, 26, 26, 28, 27, 27, 27, 20, 24, 20, 21, 22, 21, 21, 23, 22, 22, 25, 25, 24, 24, 26, 23, 26, 27, 26, 26, 27, 27, 27, 27, 27, 28, 27, 27, 27, 27, 27, 26, 30];
  /*从 UUID 推导 XHTTP 短路径的字段与参数名。*/
  function trojanPathFields(e) {
    return {
      头: e.slice(1, 7),
      键: "_" + e.slice(25, 31)
    };
  }
  /*估算请求头参数的长度（用于校验 xhttp 首包）。*/
  function estimateHeaderBytes(e) {
    const n = new TextEncoder().encode(e);
    let t = 0;
    for (let r = 0; r < n.length; r++) t += bn[n[r]];
    return Math.ceil(t / 8);
  }
  /*从请求头里读指定参数。*/
  function readHeaderParam(e, n, t) {
    const r = e.headers.get(n);
    if (r) {
      try {
        const a = new URL(r, "https://x.invalid").searchParams.get(t);
        if (a) return a;
      } catch {}
      return r;
    }
    try {
      return new URL(e.url).searchParams.get(t) || "";
    } catch {
      return "";
    }
  }
  /*校验 xhttp 的 ed 长度参数是否在合理区间。*/
  function hasValidXhttpLength(e, n, t) {
    const r = readHeaderParam(e, n, t);
    if (!r) return !0;
    const o = estimateHeaderBytes(r);
    return o >= 98 && o <= 1002;
  }
  const ct = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  /*生成随机字母数字串（xhttp 参数随机值）。*/
  function randomAlphaNumeric(e) {
    const n = ct.length;
    let t = "";
    for (let r = 0; r < e; r++) t += ct[Math.floor(Math.random() * n)];
    return t;
  }
  /*sleep。*/
  function sleep(e) {
    return new Promise(n => setTimeout(n, e));
  }
  /*定长常量时间比较（Trojan 密码）。*/
  function timingSafeEqual(e, n) {
    for (let t = 0; t < 16; t++) if (e[t] !== n[t]) return !1;
    return !0;
  }
  class it {
    #e;
    constructor() {
      this.#e = 0;
    }
    get() {
      return this.#e;
    }
    add(n) {
      this.#e += n;
    }
  }
  /*拼接多个 Uint8Array。*/
  function concatArrays(e, ...n) {
    let t = e.length;
    for (let o of n) t += o.length;
    const r = new e.constructor(t);
    r.set(e, 0), t = e.length;
    for (let o of n) r.set(o, t), t += o.length;
    return r;
  }
  /*十六进制转字节。*/
  function hexToBytes(e) {
    e = e.replaceAll("-", "");
    const n = [];
    for (let t = 0; t < 16; t++) {
      const r = parseInt(e.substr(t * 2, 2), 16);
      n.push(r);
    }
    return n;
  }
  /*分配指定长度的 Uint8Array。*/
  function allocateBytes(e) {
    return new Uint8Array(new ArrayBuffer(e || at));
  }
  /*读取 gRPC 帧（HTTP/2 stream-one）。*/
  async function readGrpcFrames(e, n) {
    const t = e.getReader({
      mode: "byob"
    });
    try {
      let r = await t.readAtLeast(18, allocateBytes());
      v.consume(r.value?.byteLength || 0);
      let o = 0,
        a = 0,
        s = r.value;
      o += r.value.length;
      const u = s[0],
        f = s.slice(1, 17),
        i = hexToBytes(n);
      if (!timingSafeEqual(f, i)) return "invalid UUID";
      const h = s[17],
        l = 18 + h + 1 + 2 + 1;
      if (l + 1 > o) {
        if (r.done) return "header too short";
        a = l + 1 - o, r = await t.readAtLeast(a, allocateBytes()), v.consume(r.value?.byteLength || 0), o += r.value.length, s = concatArrays(s, r.value);
      }
      const c = s[18 + h];
      if (c !== 1) return `unsupported command: ${c}`;
      const d = (s[l - 1 - 2] << 8) + s[l - 1 - 1],
        p = s[l - 1];
      let g = -1;
      if (p === xe ? g = l + 4 : p === Ee ? g = l + 16 : p === ue && (g = l + 1 + s[l]), g < 0) return "read address type failed";
      if (a = g - o, a > 0) {
        if (r.done) return "read address failed";
        r = await t.readAtLeast(a, allocateBytes()), v.consume(r.value?.byteLength || 0), o += r.value.length, s = concatArrays(s, r.value);
      }
      let w = "";
      switch (a = l, p) {
        case xe:
          w = s.slice(a, a + 4).join(".");
          break;
        case ue:
          w = new TextDecoder().decode(s.slice(a + 1, a + 1 + s[a]));
          break;
        case Ee:
          w = s.slice(a, a + 16).reduce((x, S, L, H) => L % 2 ? x.concat(((H[L - 1] << 8) + S).toString(16)) : x, []).join(":");
          break;
      }
      if (w.length < 1) return "failed to parse hostname";
      const U = s.slice(g);
      return {
        hostname: w,
        port: d,
        data: U,
        resp: new Uint8Array([u, 0]),
        reader: t,
        done: r.done
      };
    } catch (r) {
      try {
        t.releaseLock();
      } catch {}
      throw r;
    }
  }
  /*把 ReadableStream 写入 WritableStream。*/
  async function writeStreamToWriter(e, n, t) {
    async function writeChunked(o) {
      if (!(!o || o.length === 0)) {
        e.add(o.length);
        try {
          await n.write(o);
        } catch (a) {
          throw a;
        }
      }
    }
    try {
      await writeChunked(t.data);
      let o = 0;
      for (; !t.done;) {
        const a = await t.reader.read(allocateBytes());
        if (a.done) break;
        v.consume(a.value?.byteLength || 0), await writeChunked(a.value), t.done = a.done, o++, !v.enabled && o % 10 === 0 && (await sleep(0)), (!a.value || a.value.length === 0) && (await sleep(2));
      }
    } catch (o) {
      throw o;
    }
  }
  /*把上传流接到 writer 上。*/
  function pipeToWriter(e, n) {
    const t = new it(),
      r = n.getWriter(),
      o = (async () => {
        try {
          await writeStreamToWriter(t, r, e);
        } catch (a) {
          if (!v.exhausted) throw a;
        } finally {
          try {
            await r.close();
          } catch {}
        }
      })();
    return {
      counter: t,
      done: o,
      abort: () => {
        try {
          r.abort().catch(() => {});
        } catch {}
      }
    };
  }
  /*通过 TransformStream 转发并计费。*/
  function pipeThroughTransform(e, n) {
    const t = new it();
    let r, o, a;
    const s = new Promise((u, f) => {
      r = new TransformStream({
        start(d) {
          t.add(e.length), d.enqueue(e);
        },
        transform(d, p) {
          t.add(d.length), p.enqueue(d);
        },
        cancel(d) {
          f(`download cancelled: ${d}`);
        }
      }, null, new ByteLengthQueuingStrategy({
        highWaterMark: at
      }));
      let i = Date.now();
      const h = setInterval(() => {
          if (Date.now() - i > st) {
            try {
              r.writable.abort?.("idle timeout");
            } catch {}
            clearInterval(h), f("idle timeout");
          }
        }, 5e3),
        l = o = n.getReader(),
        c = a = r.writable.getWriter();
      (async () => {
        try {
          let d = 0;
          for (;;) {
            const p = await l.read();
            if (p.done) break;
            v.consume(p.value?.byteLength || 0), i = Date.now(), await c.write(p.value), d++, !v.enabled && d % 5 === 0 && (await sleep(0));
          }
          await c.close(), u();
        } catch (d) {
          if (v.exhausted) {
            try {
              await c.close();
            } catch {}
            u();
          } else f(d);
        } finally {
          try {
            l.releaseLock();
          } catch {}
          try {
            c.releaseLock();
          } catch {}
          clearInterval(h);
        }
      })();
    });
    return {
      readable: r.readable,
      counter: t,
      done: s,
      finish: () => {
        try {
          o?.cancel().catch(() => {});
        } catch {}
        try {
          a?.close().catch(() => {});
        } catch {}
      },
      abort: () => {
        try {
          o?.cancel().catch(() => {});
        } catch {}
        try {
          a?.abort().catch(() => {});
        } catch {}
      }
    };
  }
  /*带 Free 预算的管道：超预算时关闭两端。*/
  function pipeWithFreeGuard(e, n) {
    let t, r;
    return v.onExhausted(() => {
      try {
        n.close();
      } catch {}
      t?.abort(), r?.finish();
    }), t = pipeToWriter(e, n.writable), r = pipeThroughTransform(e.resp, n.readable), {
      downloader: r,
      uploader: t,
      close: () => {
        try {
          n.close();
        } catch {}
      }
    };
  }
  /*解析实际连接目标：ProxyIP / 优选地址 / 自定义域名。*/
  async function resolveDestination(e, n = null) {
    const t = e.hostname,
      r = e.port,
      connectDirect = async (f, i) => raceConnect(f, i, n, Ze),
      connectViaProxy = async (f, i) => dialProxy(ue, f, i, ne, n, null),
      resolvePreferredAddress = async () => {
        if (N && N.trim()) {
          const i = parseHostPort(N);
          return {
            address: i.address,
            port: i.port || r
          };
        }
        const f = await pickEndpointByRegion(J, ee);
        return f ? {
          address: f.domain,
          port: f.port
        } : {
          address: t,
          port: r
        };
      },
      u = q && j ? !0 : Q ? !1 : j;
    try {
      const f = u ? await connectViaProxy(t, r) : await connectDirect(t, r);
      return pipeWithFreeGuard(e, f);
    } catch {
      if (q && j) return null;
      try {
        if (Q && j) try {
          const l = await connectViaProxy(t, r);
          return pipeWithFreeGuard(e, l);
        } catch {
          const c = await resolvePreferredAddress(),
            d = await connectDirect(c.address, c.port);
          return pipeWithFreeGuard(e, d);
        }
        const i = await resolvePreferredAddress(),
          h = j ? await connectViaProxy(i.address, i.port) : await connectDirect(i.address, i.port);
        return pipeWithFreeGuard(e, h);
      } catch {
        return null;
      }
    }
  }
  /*连接数上限保护，超过返回 429。*/
  async function limitConcurrency(e, n, t = null) {
    if (de >= gn) return new Response("Too many connections", {
      status: 429
    });
    de++;
    let r = !1;
    const releaseSlot = () => {
      r || (de = Math.max(0, de - 1), r = !0);
    };
    try {
      const a = await readGrpcFrames(e, n);
      if (typeof a != "object" || !a) return null;
      const s = await resolveDestination(a, t);
      if (s === null) return null;
      const u = Promise.race([(async () => {
        try {
          await s.downloader.done;
        } catch {}
      })(), (async () => {
        try {
          await s.uploader.done;
        } catch {}
      })(), sleep(st).then(() => {})]).finally(() => {
        try {
          s.close();
        } catch {}
        try {
          v.exhausted ? s.downloader.finish() : s.downloader.abort();
        } catch {}
        try {
          s.uploader.abort();
        } catch {}
        releaseSlot();
      });
      return {
        readable: s.downloader.readable,
        closed: u
      };
    } catch {
      return releaseSlot(), null;
    }
  }
  /*带上限的 fetch（XHTTP 转发）。*/
  async function fetchWithLimit(e) {
    try {
      return await limitConcurrency(e.body, k, e.fetcher);
    } catch {
      return null;
    }
  }
  /*解码 early-data base64url 头。*/
  function decodeEarlyDataHeader(e) {
    if (!e) return {
      error: null
    };
    try {
      return e = e.replace(/-/g, "+").replace(/_/g, "/"), {
        earlyData: Uint8Array.from(atob(e), n => n.charCodeAt(0)).buffer,
        error: null
      };
    } catch (n) {
      return {
        error: n
      };
    }
  }
  /*安全关闭 WebSocket。*/
  function closeWebSocket(e) {
    try {
      (e.readyState === 1 || e.readyState === 2) && e.close();
    } catch {}
  }
  /*优选 IP 管理 API（GET/POST/DELETE），需 KV 且开启「允许 API 管理」。*/
  async function handlePreferredIpsApi(e) {
    if (!D) return new Response(JSON.stringify({
      success: !1,
      error: "KV存储未配置",
      message: "需要配置KV存储才能使用此功能"
    }), {
      status: 503,
      headers: {
        "Content-Type": "application/json"
      }
    });
    if (!(getConfigValue("ae", "") === "yes")) return new Response(JSON.stringify({
      success: !1,
      error: "API功能未启用",
      message: '出于安全考虑，优选IP API功能默认关闭。请在配置管理页面开启"允许API管理"选项后使用。'
    }), {
      status: 403,
      headers: {
        "Content-Type": "application/json"
      }
    });
    try {
      if (e.method === "GET") {
        const t = getConfigValue("yx", ""),
          r = parsePreferredList(t);
        return new Response(JSON.stringify({
          success: !0,
          count: r.length,
          data: r
        }), {
          headers: {
            "Content-Type": "application/json"
          }
        });
      } else if (e.method === "POST") {
        const t = await e.json(),
          r = Array.isArray(t) ? t : [t];
        if (r.length === 0) return new Response(JSON.stringify({
          success: !1,
          error: "请求数据为空",
          message: "请提供IP数据"
        }), {
          status: 400,
          headers: {
            "Content-Type": "application/json"
          }
        });
        const o = getConfigValue("yx", "");
        let a = parsePreferredList(o);
        const s = [],
          u = [],
          f = [];
        for (const i of r) {
          if (!i.ip) {
            f.push({
              ip: "未知",
              reason: "IP地址是必需的"
            });
            continue;
          }
          const 输入地址 = String(i.ip).trim().replace(/^\[([^\]]+)\]$/, "$1"),
            h = i.port === void 0 || i.port === null || i.port === "" ? 443 : parseInt(i.port, 10),
            l = String(i.name || "").replace(/[#,\r\n]/g, " ").trim() || `API优选-${输入地址}:${h}`;
          if (!isIpAddress(输入地址) && !isDomainName(输入地址)) {
            f.push({
              ip: i.ip,
              reason: "无效的IP或域名格式"
            });
            continue;
          }
          if (!Number.isInteger(h) || h < 1 || h > 65535) {
            f.push({
              ip: 输入地址,
              reason: "无效的端口: " + i.port
            });
            continue;
          }
          if (a.some(p => p.ip === 输入地址 && p.port === h)) {
            u.push({
              ip: 输入地址,
              port: h,
              reason: "已存在"
            });
            continue;
          }
          const d = {
            ip: 输入地址,
            port: h,
            name: l,
            addedAt: new Date().toISOString()
          };
          a.push(d), s.push(d);
        }
        if (s.length > 0) {
          const i = serializePreferredList(a);
          await setConfigValue("yx", i), reloadPreferredFromKv();
        }
        return new Response(JSON.stringify({
          success: s.length > 0,
          message: `成功添加 ${s.length} 个IP`,
          added: s.length,
          skipped: u.length,
          errors: f.length,
          data: {
            addedIPs: s,
            skippedIPs: u.length > 0 ? u : void 0,
            errors: f.length > 0 ? f : void 0
          }
        }), {
          headers: {
            "Content-Type": "application/json"
          }
        });
      } else if (e.method === "DELETE") {
        const t = await e.json();
        if (t.all === !0) {
          const i = getConfigValue("yx", ""),
            l = parsePreferredList(i).length;
          return await setConfigValue("yx", ""), reloadPreferredFromKv(), new Response(JSON.stringify({
            success: !0,
            message: `已清空所有优选IP，共删除 ${l} 个`,
            deletedCount: l
          }), {
            headers: {
              "Content-Type": "application/json"
            }
          });
        }
        if (!t.ip) return new Response(JSON.stringify({
          success: !1,
          error: "IP地址是必需的",
          message: '请提供要删除的ip字段，或使用 {"all": true} 清空所有'
        }), {
          status: 400,
          headers: {
            "Content-Type": "application/json"
          }
        });
        const r = t.port || 443,
          o = getConfigValue("yx", "");
        let a = parsePreferredList(o);
        const s = a.length,
          u = a.filter(i => !(i.ip === t.ip && i.port === r));
        if (u.length === s) return new Response(JSON.stringify({
          success: !1,
          error: "优选IP不存在",
          message: `${t.ip}:${r} 未找到`
        }), {
          status: 404,
          headers: {
            "Content-Type": "application/json"
          }
        });
        const f = serializePreferredList(u);
        return await setConfigValue("yx", f), reloadPreferredFromKv(), new Response(JSON.stringify({
          success: !0,
          message: "优选IP已删除",
          deleted: {
            ip: t.ip,
            port: r
          }
        }), {
          headers: {
            "Content-Type": "application/json"
          }
        });
      } else return new Response(JSON.stringify({
        success: !1,
        error: "不支持的请求方法",
        message: "支持的方法: GET, POST, DELETE"
      }), {
        status: 405,
        headers: {
          "Content-Type": "application/json"
        }
      });
    } catch (t) {
      return new Response(JSON.stringify({
        success: !1,
        error: "处理请求失败",
        message: t.message
      }), {
        status: 500,
        headers: {
          "Content-Type": "application/json"
        }
      });
    }
  }
  /*把配置应用到闭包状态（协议开关、ProxyIP、地区、优选列表等）。*/
  function applyRuntimeConfig() {
    const e = effectiveConfig();
    v = createFreeCpuGuard(e.freeCpu === "yes");
    const n = e.wk;
    if (n && n.trim()) B = n.trim().toUpperCase(), J = B;else {
      const r = e.p;
      r && r.trim() ? J = "CUSTOM" : (B = "", J = "");
    }
    ee = !(e.rm && e.rm.toLowerCase() === "no"), Re = e.ev === "yes", Ne = e.et === "yes", Ie = e.ex === "yes", ce = e.tp || "", Et = e.scu || F.scu, Ut = e.epd === "yes", Ct = e.epi === "yes", St = e.egi === "yes", Lt = e.ena === "yes", Tt = e.jk === "yes", Pe = e.ech === "yes", bt = e.customDNS || F.customDNS, mt = e.customECHDomain || F.customECHDomain, xt = normalizeAlpn(e.alpn || ""), yt = e.dkby === "yes" || Pe;
    const t = (e.qj || "").toLowerCase();
    if (Q = t === "no", q = t === "only", be = e.d || "", gt = e.yxURL || "", N = e.p ? e.p.trim() : "", $ = e.s || "", $) try {
      ne = parseOutboundSpec($), j = !0;
    } catch {
      j = !1;
    } else ne = {}, j = !1;
    wt = !!(e.yxby && e.yxby.toLowerCase() === "yes");
  }
  /*从 KV 重新加载优选列表到内存。*/
  function reloadPreferredFromKv() {
    const e = getConfigValue("yx", "");
    if (e) try {
      const n = e.split(/[,\r\n]+/).map(t => t.trim()).filter(t => t);
      I = [], _ = [], n.forEach(t => {
        let r = "",
          o = t;
        if (t.includes("#")) {
          const u = t.split("#");
          o = u[0].trim(), r = u[1].trim();
        }
        const {
          address: a,
          port: s
        } = parseHostPort(o);
        r || (r = "自定义优选-" + a + (s ? ":" + s : "")), isIpAddress(a) ? I.push({
          ip: a,
          port: s,
          isp: r
        }) : _.push({
          domain: a,
          port: s,
          name: r
        });
      });
    } catch {
      I = [], _ = [];
    } else I = [], _ = [];
  }
  /*解析优选列表字符串（逗号/换行分隔，# 备注）。*/
  function parsePreferredList(e) {
    if (!e || !e.trim()) return [];
    const n = e.split(/[,\r\n]+/).map(r => r.trim()).filter(r => r),
      t = [];
    for (const r of n) {
      let o = "",
        a = r;
      if (r.includes("#")) {
        const f = r.split("#");
        a = f[0].trim(), o = f[1].trim();
      }
      const {
        address: s,
        port: u
      } = parseHostPort(a);
      if (!s || !isIpAddress(s) && !isDomainName(s)) continue;
      o || (o = s + (u ? ":" + u : "")), t.push({
        ip: s,
        port: u || 443,
        name: o,
        addedAt: new Date().toISOString()
      });
    }
    return t;
  }
  /*把优选列表序列化回字符串（IPv6 补方括号，备注去掉分隔符）。*/
  function serializePreferredList(e) {
    return !e || e.length === 0 ? "" : e.map(n => {
      const t = n.port || 443,
        a = n.ip && n.ip.includes(":") && !n.ip.startsWith("[") ? `[${n.ip}]` : n.ip;
      return `${a}:${t}#${String(n.name || "").replace(/[#,\r\n]/g, " ").trim()}`;
    }).join(",");
  }
  /*域名格式校验。*/
  function isDomainName(e) {
    return /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/.test(e);
  }
  /*路由入口：首页 / 配置 API / 优选 API / 地区 / XHTTP / WebSocket。*/
  async function routeRequest(e, n, t = {
    waitUntil() {}
  }) {
    if (e.method === "OPTIONS") return new Response(null, {
      status: 204,
      headers: CORS_HEADERS
    });
    const r = new URL(e.url);
    if (r.pathname === "/" && e.method === "GET" && !e.headers.get("Upgrade")) return new Response("hello", {
      headers: {
        "Content-Type": "text/plain; charset=utf-8"
      }
    });
    if (k = String(n.u || n.U || k).trim().toLowerCase(), !isUuid(k)) return jsonResponse({
      error: "UUID 格式无效"
    }, 503);
    D = n.C || n.c || null, M = await readKvConfigCached(D, r.pathname.endsWith("/api/config"));
    const o = M;
    M = effectiveConfig(n), applyRuntimeConfig(), J ||= "CF", M = o;
    //判断路径是否命中某个 API 前缀（UUID 或自定义路径）。
    const a = "/" + k,
      s = be ? new URL("/" + be.replace(/^\/+|\/+$/g, ""), "https://path.invalid").pathname : "",
      isApiPath = i => r.pathname === a + i || s && r.pathname === s + i;
    if (isApiPath("/api/config")) {
      if (e.method === "GET") return jsonResponse({
        ...effectiveConfig(n),
        uuid: k,
        coreVersion: CORE_VERSION,
        kvEnabled: !!D
      });
      if (e.method !== "POST") return jsonResponse({
        error: "只支持 GET 和 POST"
      }, 405);
      if (!D) return jsonResponse({
        success: !1,
        message: "KV 未绑定，无法保存配置"
      }, 503);
      let i;
      try {
        const h = await e.text();
        if (new TextEncoder().encode(h).length > 1048576) return jsonResponse({
          success: !1,
          message: "配置过大，请减少优选条目或改用列表 URL（请求上限 1 MiB）"
        }, 413);
        if (i = JSON.parse(h), !i || Array.isArray(i) || typeof i != "object") throw new Error();
        Object.hasOwn(i, "customIP") && (Object.hasOwn(i, "p") || (i.p = i.customIP), delete i.customIP);
        for (const [l, c] of Object.entries(i)) {
          if (!Object.hasOwn(F, l) || c !== null && !["string", "boolean", "number"].includes(typeof c)) throw new Error();
          if (typeof c == "string" && c.length > (l === "yx" ? 262144 : 16384)) return jsonResponse({
            success: !1,
            message: l === "yx" ? "优选列表过长，请减少条目或改用列表 URL（上限 262144 字符）" : "配置字段过长：" + l
          }, 413);
          c === "" || c === null ? delete M[l] : M[l] = c;
        }
      } catch {
        return jsonResponse({
          success: !1,
          message: "配置格式无效"
        }, 400);
      }
      return await persistConfig(), kvConfigCache.delete(D), jsonResponse({
        success: !0,
        message: "配置已保存",
        config: {
          ...effectiveConfig(n),
          coreVersion: CORE_VERSION
        }
      });
    }
    if (isApiPath("/api/preferred-ips")) {
      const i = await handlePreferredIpsApi(e);
      return e.method !== "GET" && i.ok && D && kvConfigCache.delete(D), withCorsHeaders(i);
    }
    if (isApiPath("/region") && e.method === "GET") return jsonResponse({
      region: J,
      detectionMethod: B ? "手动指定地区" : N ? "自定义 ProxyIP 模式" : "官方直连",
      manualRegion: B,
      ci: N,
      timestamp: new Date().toISOString()
    });
    if (isApiPath("/test-api") && e.method === "GET") return jsonResponse({
      detectedRegion: J,
      message: "API 正常运行"
    });
    if (e.headers.get("Upgrade")?.toLowerCase() === atob("d2Vic29ja2V0")) return handleWebSocketUpgrade(e);
    const f = r.pathname.replace(/\/+$/, "");
    if (e.method === "POST" && Ie && (isApiPath("") || f === a || f === "/" + k.substring(0, 8) || ce && f === "/" + ce.replace(/^\/+|\/+$/g, ""))) {
      const {
        头: i,
        键: h
      } = trojanPathFields(k);
      if (!hasValidXhttpLength(e, i, h)) return new Response("Bad Request", {
        status: 400
      });
      const l = await fetchWithLimit(e);
      if (!l) return new Response("Internal Server Error", {
        status: 502
      });
      t.waitUntil(l.closed.catch(() => {}));
      const c = new URL("https://x.invalid/");
      return c.searchParams.set(h, randomAlphaNumeric(100 + Math.floor(Math.random() * 901))), new Response(l.readable, {
        headers: {
          "X-Accel-Buffering": "no",
          "Cache-Control": "no-store",
          "Content-Type": "application/grpc",
          [i]: c.toString()
        }
      });
    }
    return jsonResponse({
      error: "Not Found"
    }, 404);
  }
  return routeRequest;
}
export { workerModule as default };
