import { readFile, writeFile, rename } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const ROLE_ID = '1561292516970602539';
export const SOURCES = [
  ...[['1018', '공지사항'], ['1076', '업데이트'], ['1077', '개발자 편지'],
      ['1073', '상점 안내'], ['1039', '진행 이벤트'], ['1040', '당첨 안내']]
    .map(([board, label]) => ({key: `kr-${board}`, region: 'kr', country: '한국', board, label})),
  {key: 'jp', region: 'jp', country: '일본', label: '공식 뉴스'},
];

export function listUrl(source, page = 1) {
  return source.board
    ? `https://forum.nexon.com/api/v1/board/${source.board}/threads?alias=bluearchive&paginationType=PAGING&pageSize=50&pageNo=${page}&blockSize=5&hideType=WEB`
    : `https://api-web.bluearchive.jp/api/news/list?typeId=0&pageNum=50&pageIndex=${page}`;
}

export function parseItems(source, data) {
  const rows = source.board ? data.threads : data.meta?.ok ? data.data?.rows : null;
  if (!Array.isArray(rows) || !rows.length) throw new Error(`${source.key}: empty or invalid official feed`);
  return rows.map(row => {
    const id = String(source.board ? row.threadId : row.id);
    const title = (source.board ? row.title : row.summary || row.title)?.trim();
    const published = Number(source.board ? row.createDate * 1000 : row.publishTime);
    if (!/^\d+$/.test(id) || !title || !Number.isFinite(published)) throw new Error(`${source.key}: invalid notice`);
    return {id, title, published, rawContent: source.board ? '' : row.content || '', url: source.board
      ? `https://forum.nexon.com/bluearchive/board_view?board=${source.board}&thread=${id}`
      : `https://bluearchive.jp/news/newsJump/${id}`};
  });
}

export function htmlToText(html = '') {
  const entities = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' '};
  return String(html)
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\s*(br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (_, code) => {
      if (code[0] !== '#') return entities[code.toLowerCase()] ?? `&${code};`;
      const point = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(point) ? String.fromCodePoint(point) : '';
    })
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function excerpt(text, max = 1800) {
  const clean = String(text || '').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const boundary = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf('. '), cut.lastIndexOf('。'));
  return `${cut.slice(0, boundary > max * 0.55 ? boundary + 1 : max).trim()}…`;
}

function splitForTranslation(text, max = 430) {
  const chunks = [];
  let rest = text.trim();
  while (rest) {
    if (rest.length <= max) { chunks.push(rest); break; }
    const window = rest.slice(0, max + 1);
    const boundary = Math.max(window.lastIndexOf('\n'), window.lastIndexOf('。'), window.lastIndexOf('！'), window.lastIndexOf('？'));
    const size = boundary > max * 0.5 ? boundary + 1 : max;
    chunks.push(rest.slice(0, size));
    rest = rest.slice(size).trimStart();
  }
  return chunks;
}

export async function translateJapanese(text, fetcher = fetch) {
  const translated = [];
  for (const chunk of splitForTranslation(text)) {
    const url = new URL('https://api.mymemory.translated.net/get');
    url.searchParams.set('q', chunk);
    url.searchParams.set('langpair', 'ja|ko');
    const response = await fetcher(url, {headers: {'User-Agent': 'BlueArchiveNoticeRelay/2.0'}, signal: AbortSignal.timeout(20000)});
    if (!response.ok) throw new Error(`translation HTTP ${response.status}`);
    const data = await response.json();
    if (data.responseStatus !== 200 || data.quotaFinished || !data.responseData?.translatedText) {
      throw new Error(`translation unavailable: ${data.responseDetails || 'invalid response'}`);
    }
    translated.push(data.responseData.translatedText);
  }
  return translated.join('\n').trim();
}

async function enrichItem(source, item) {
  if (source.region === 'kr') {
    const detail = await getJson(`https://forum.nexon.com/api/v1/thread/${item.id}?alias=bluearchive`);
    const body = htmlToText(detail.content);
    return {...item, displayTitle: item.title, body: excerpt(body || detail.summary || '이미지 중심 공지입니다. 상세 내용은 원문 링크에서 확인해 주세요.'),
      image: /^https:\/\//.test(detail.thumbnailImageUrl || '') ? detail.thumbnailImageUrl : undefined};
  }
  const originalBody = excerpt(htmlToText(item.rawContent), 1050) || '상세 내용은 원문 링크에서 확인해 주세요.';
  const [displayTitle, body] = await Promise.all([
    translateJapanese(item.title),
    translateJapanese(originalBody),
  ]);
  return {...item, displayTitle, body: excerpt(body), originalTitle: item.title};
}

export function pendingItems(items, state) {
  const seen = new Set(state.seen);
  return [...new Map(items.map(item => [item.id, item])).values()]
    .filter(item => !seen.has(item.id) && item.published >= state.startedAt)
    .sort((a, b) => a.published - b.published || Number(a.id) - Number(b.id));
}

export function payload(source, item) {
  const embed = {
    title: item.displayTitle.slice(0, 256),
    description: `**공지 내용**\n${item.body}`.slice(0, 4096),
    url: item.url,
    color: source.country === '한국' ? 0x39a9ed : 0xf391b6,
    footer: {text: `${source.country} 공식 · ${source.label} | 자세한 내용은 원문 링크에서 확인하세요`},
    timestamp: new Date(item.published).toISOString(),
  };
  if (item.originalTitle) embed.fields = [{name: '일본어 원문 제목', value: item.originalTitle.slice(0, 1024)}];
  if (item.image) embed.thumbnail = {url: item.image};
  return {
    content: `<@&${ROLE_ID}> ${source.country === '한국' ? '🇰🇷' : '🇯🇵'} **${source.country} 서버 새 공지**`,
    allowed_mentions: {parse: [], roles: [ROLE_ID], users: [], replied_user: false},
    embeds: [embed],
  };
}

async function getJson(url) {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, {headers: {'User-Agent': 'BlueArchiveNoticeRelay/1.0'}, signal: AbortSignal.timeout(20000)});
      if (!response.ok) throw new Error(`official feed HTTP ${response.status}`);
      return await response.json();
    } catch (error) { last = error; }
  }
  throw last;
}

export async function postDiscord(webhook, body, fetcher = fetch) {
  const url = new URL(webhook);
  if (url.protocol !== 'https:' || url.hostname !== 'discord.com' || !/^\/api\/webhooks\/\d+\/[^/]+$/.test(url.pathname)) {
    throw new Error('Invalid Discord webhook configuration');
  }
  url.searchParams.set('wait', 'true');
  // Do not blindly retry ambiguous network/5xx failures: Discord may already have accepted a message.
  for (let attempt = 0; attempt < 3; attempt++) {
    let response;
    try {
      response = await fetcher(url, {method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body), signal: AbortSignal.timeout(20000)});
    } catch { throw new Error('Discord delivery status uncertain; inspect channel before retrying'); }
    if (response.status === 429) {
      const data = await response.json();
      await new Promise(resolve => setTimeout(resolve, Math.min(Number(data.retry_after) * 1000 + 250, 15000)));
      continue;
    }
    if (!response.ok) throw new Error(`Discord HTTP ${response.status}`);
    const receipt = await response.json();
    if (!receipt.id) throw new Error('Discord did not return a message receipt');
    return receipt;
  }
  throw new Error('Discord rate limit: retry on next scheduled run');
}

async function save(state, file) {
  await writeFile(`${file}.tmp`, JSON.stringify(state, null, 2) + '\n');
  await rename(`${file}.tmp`, file);
}

export async function run() {
  const preview = process.argv.includes('--preview');
  const region = (process.env.REGION || '').toLowerCase();
  if (region && !['kr', 'jp'].includes(region)) throw new Error('REGION must be kr or jp');
  const activeSources = region ? SOURCES.filter(source => source.region === region) : SOURCES;
  const file = process.env.STATE_FILE || 'state.json';
  const webhook = process.env.DISCORD_WEBHOOK_URL;
  if (!preview && !webhook) throw new Error('DISCORD_WEBHOOK_URL secret is missing');
  let state;
  try { state = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    state = {version: 1, sources: {}};
  }
  if (state.version !== 1 || !state.sources) throw new Error('Invalid saved state; refusing to reset it');
  let failed = false;
  for (const source of activeSources) {
    try {
      const first = await getJson(listUrl(source));
      let items = parseItems(source, first);
      if (preview) {
        console.log(JSON.stringify({source: source.key, count: items.length, latest: items[0]}, null, 2));
        continue;
      }
      let saved = state.sources[source.key];
      if (!saved) {
        state.sources[source.key] = {startedAt: Date.now(), seen: items.map(item => item.id)};
        await save(state, file);
        console.log(`${source.key}: initialized; historical notices skipped`);
        continue;
      }
      if (saved.uncertain) throw new Error(`${source.key}: uncertain previous delivery requires manual review`);
      const pages = source.board ? first.totalPages : Math.ceil(first.data.count / 50);
      // Fetch up to five pages when catching up after an outage. Stop once all entries predate setup.
      for (let page = 2; page <= Math.min(pages, 5); page++) {
        if (items.every(item => item.published < saved.startedAt) || items.some(item => saved.seen.includes(item.id))) break;
        items.push(...parseItems(source, await getJson(listUrl(source, page))));
      }
      for (const item of pendingItems(items, saved)) {
        const enriched = await enrichItem(source, item);
        saved.uncertain = {id: item.id, url: item.url};
        await save(state, file);
        let receipt;
        try { receipt = await postDiscord(webhook, payload(source, enriched)); }
        catch (error) {
          // A definite 4xx (including rate limits) has not created a message and can safely retry later.
          if (/HTTP 4\d\d|rate limit/.test(error.message)) { delete saved.uncertain; await save(state, file); }
          throw error;
        }
        saved.seen.push(item.id);
        saved.lastMessageId = receipt.id;
        delete saved.uncertain;
        await save(state, file);
        console.log(`${source.key}: delivered notice ${item.id}`);
      }
      // Keep identifiers permanently; reappearing pinned notices must never trigger duplicate pings.
    } catch (error) {
      failed = true;
      console.error(`${source.key}: ${error.message}`);
    }
  }
  if (!preview && process.env.SEND_TEST === 'true') {
    const receipt = await postDiscord(webhook, {
      content: `<@&${ROLE_ID}> ✅ 한국·일본 공식 공지 알림 연결 테스트입니다.\n한국·일본을 각각 5분마다 확인하며, 공지 내용과 원문 링크를 전달합니다. 일본 공지는 한국어 번역도 함께 표시합니다. 예약 실행은 GitHub 사정으로 지연될 수 있습니다.`,
      allowed_mentions: {parse: [], roles: [ROLE_ID], users: [], replied_user: false},
    });
    state.testMessageId = receipt.id;
    await save(state, file);
    console.log('Test notification delivered');
  }
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch(error => { console.error(error.message); process.exitCode = 1; });
}
