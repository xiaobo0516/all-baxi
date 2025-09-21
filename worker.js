export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const rootDomain = url.hostname;
    const domain = url.origin;

    // -------- 谷歌验证 --------
    const googleVerifications = {
      "/google59908a378b7b0df5.html": "google59908a378b7b0df5.html",
    };
    if (googleVerifications[url.pathname]) {
      return new Response(`google-site-verification: ${googleVerifications[url.pathname]}`, {
        headers: { "Content-Type": "text/html; charset=UTF-8" },
      });
    }

    // -------- robots.txt --------
    if (url.pathname === "/robots.txt") {
      const robotsTxt = `User-agent: *
      Disallow:
      Sitemap: ${domain}/sitemap.xml`;
      return new Response(robotsTxt, {
        headers: { "Content-Type": "text/plain; charset=UTF-8" },
      });
    }

    // -------- sitemap.xml --------
    if (url.pathname === "/sitemap.xml") {
      const today = new Date().toISOString().split("T")[0];
      const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url>
          <loc>${domain}/</loc>
          <lastmod>${today}</lastmod>
          <changefreq>daily</changefreq>
          <priority>1.0</priority>
        </url>
      </urlset>`;
      return new Response(sitemap, {
        headers: { "Content-Type": "application/xml; charset=UTF-8" },
      });
    }

    // 只缓存 GET 请求
    const cache = caches.default;
    const cacheKey = new Request(request.url, request);
    if (request.method === "GET") {
      const cachedResponse = await cache.match(cacheKey);
      if (cachedResponse) return cachedResponse;
    }

    // 查询 D1 数据库
    let keyword = "", content = "", description="";
    try {
      const query = `SELECT keyword, content FROM webs_new WHERE domain = ?`;
      const stmt = env.D1BAXI.prepare(query).bind(rootDomain);
      const dbRes = await stmt.first();
      if (dbRes) {
        keyword = dbRes.keyword ?? "";
        content = dbRes.content ?? "";
      }
    } catch (e) {
      console.error("D1 查询失败:", e.message || e);
    }

    // 高效处理内容：去空格、按句子拆分、包装 <p>
    if (content) {
      const sentences = content.trim().split(/\.\s*/g).filter(Boolean);
      description = sentences[0] ? sentences[0] + '.' : '';
      const paragraphs = sentences
        .map(p => `<p>${p.endsWith('.') ? p : p + '.'}</p>`)
        .join("\n");
      content = paragraphs;
    }
    
    // 从静态目录取文件
    const asset = await env.ASSETS.fetch(request);
    const replacements = {
      "{关键词}": keyword,
      "{域名}": domain,
      "{内容}": content,
      "{描述}": description
    };
    // 正则：匹配 {关键词} | {域名} | {内容}
    const replacePlaceholders = (str) =>
      str.replace(/\{关键词\}|\{域名\}|\{内容\}|\{描述\}/g, (match) => replacements[match] ?? match);
    let response = new HTMLRewriter()
      .on("*", {
        text(text) {
          const replaced = replacePlaceholders(text.text);
          if (replaced !== text.text) {
            text.replace(replaced, { html: true });
          }
        },
        element(el) {
          for (const [name, value] of el.attributes) {
            if (value.includes("{")) {
              const replaced = replacePlaceholders(value);
              if (replaced !== value) {
                el.setAttribute(name, replaced);
              }
            }
          }
        }
      })
      .transform(asset);
    
    // 创建响应对象
    response = new Response(response.body, response);

    // 设置缓存：浏览器 30 天，边缘缓存 30 天
    response.headers.set("Cache-Control", "public, max-age=2592000, s-maxage=2592000");

    // 仅 GET 请求写缓存，异步写入（不会阻塞响应）
    if (request.method === "GET") {
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
    }

    // 返回响应
    return response;
  }
}