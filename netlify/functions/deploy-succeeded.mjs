// Runs after every successful deploy and tells IndexNow (Bing, Yandex, Seznam,
// Naver; Bing also feeds ChatGPT search and DuckDuckGo) to recrawl every page
// in the sitemap, so new and changed pages show up in days instead of weeks.
const SITE = "https://brightspacemcp.com";
const KEY = "30c4a83d2f99f7d438de543bdabc7419";

export default async () => {
  try {
    const sitemap = await (await fetch(`${SITE}/sitemap.xml`, { signal: AbortSignal.timeout(10_000) })).text();
    const urlList = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    const res = await fetch("https://api.indexnow.org/indexnow", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ host: "brightspacemcp.com", key: KEY, keyLocation: `${SITE}/${KEY}.txt`, urlList }),
      signal: AbortSignal.timeout(10_000),
    });
    console.log(`IndexNow: submitted ${urlList.length} URLs, status ${res.status}`);
  } catch (error) {
    console.log(`IndexNow submission failed: ${error.message}`);
  }
  return new Response("ok");
};
