export const ARAB_NEWS_ORIGIN = "https://www.arabnews.com";

export function normalizeWhitespace(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeUrl(href, baseUrl = ARAB_NEWS_ORIGIN) {
  if (!href) return null;

  try {
    const url = new URL(href, baseUrl);
    if (!/^https?:$/.test(url.protocol)) return null;

    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$)/i.test(key)) {
        url.searchParams.delete(key);
      }
    }

    if (url.pathname.length > 1) {
      url.pathname = url.pathname.replace(/\/+$/, "");
    }

    return url.toString();
  } catch {
    return null;
  }
}

export function isCloudflareChallengeText(text, title = "") {
  const haystack = `${title}\n${text}`.toLowerCase();
  return (
    haystack.includes("just a moment") ||
    haystack.includes("checking if the site connection is secure") ||
    haystack.includes("verify you are human") ||
    haystack.includes("enable javascript and cookies") ||
    haystack.includes("cf-chl") ||
    haystack.includes("cloudflare ray id")
  );
}

export function isLikelyArabNewsArticleUrl(url) {
  const normalized = normalizeUrl(url);
  if (!normalized) return false;

  const parsed = new URL(normalized);
  const hostname = parsed.hostname.replace(/^www\./i, "");
  if (hostname !== "arabnews.com") return false;

  const path = parsed.pathname;
  if (path === "/" || path === "/videos") return false;
  if (/\.(jpg|jpeg|png|gif|webp|svg|pdf|mp4|m3u8)$/i.test(path)) return false;

  const blockedStarts = [
    "/about",
    "/advertise",
    "/contact",
    "/login",
    "/newsletters",
    "/privacy",
    "/search",
    "/services",
    "/subscribe",
    "/taxonomy",
    "/terms",
    "/user"
  ];
  if (blockedStarts.some((prefix) => path.startsWith(prefix))) return false;

  return /^\/node\/\d+/i.test(path);
}

export function dedupeItemsByUrl(items) {
  const seen = new Set();
  const result = [];

  for (const item of items) {
    const url = normalizeUrl(item?.url);
    const title = normalizeWhitespace(item?.title);
    if (!url || !title || seen.has(url)) continue;

    seen.add(url);
    result.push({
      ...item,
      url,
      title
    });
  }

  return result;
}

export function dateMatchesTargetDay(value, targetISO, timeZone = "Asia/Riyadh") {
  if (!value || !targetISO) return false;

  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return false;

  const formatted = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);

  return formatted === targetISO;
}

export function extractArabNewsDocument(options = {}) {
  const mode = options.mode || "content";
  const limit = Number(options.limit || 0);
  const baseUrl = options.baseUrl || document.location?.href || "https://www.arabnews.com/";

  function clean(value) {
    return String(value ?? "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function toUrl(href) {
    if (!href) return null;

    try {
      const url = new URL(href, baseUrl);
      if (!/^https?:$/.test(url.protocol)) return null;
      url.hash = "";
      for (const key of [...url.searchParams.keys()]) {
        if (/^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$)/i.test(key)) {
          url.searchParams.delete(key);
        }
      }
      if (url.pathname.length > 1) {
        url.pathname = url.pathname.replace(/\/+$/, "");
      }
      return url.toString();
    } catch {
      return null;
    }
  }

  function isArticleUrl(url) {
    const normalized = toUrl(url);
    if (!normalized) return false;

    const parsed = new URL(normalized);
    const hostname = parsed.hostname.replace(/^www\./i, "");
    if (hostname !== "arabnews.com") return false;

    const path = parsed.pathname;
    if (path === "/" || path === "/videos") return false;
    if (/\.(jpg|jpeg|png|gif|webp|svg|pdf|mp4|m3u8)$/i.test(path)) return false;

    const blockedStarts = [
      "/about",
      "/advertise",
      "/contact",
      "/login",
      "/newsletters",
      "/privacy",
      "/search",
      "/services",
      "/subscribe",
      "/taxonomy",
      "/terms",
      "/user"
    ];
    if (blockedStarts.some((prefix) => path.startsWith(prefix))) return false;

    return /^\/node\/\d+/i.test(path);
  }

  function isChallenge() {
    const haystack = `${document.title}\n${document.body?.innerText || ""}`.toLowerCase();
    return (
      haystack.includes("just a moment") ||
      haystack.includes("checking if the site connection is secure") ||
      haystack.includes("verify you are human") ||
      haystack.includes("enable javascript and cookies") ||
      haystack.includes("cf-chl") ||
      haystack.includes("cloudflare ray id")
    );
  }

  function closestItemRoot(anchor) {
    return (
      anchor.closest(
        "article, li, [class*='views-row'], [class*='node'], [class*='card'], [class*='media'], [class*='story'], [class*='teaser'], [class*='article']"
      ) ||
      anchor.parentElement ||
      anchor
    );
  }

  function titleFromAnchor(anchor, root) {
    const headingLink = root.querySelector("h1 a[href], h2 a[href], h3 a[href], h4 a[href]");
    const heading = root.querySelector("h1, h2, h3, h4");
    const image = anchor.querySelector("img") || root.querySelector("img");
    const candidates = [
      anchor.innerText,
      anchor.getAttribute("title"),
      anchor.getAttribute("aria-label"),
      headingLink?.innerText,
      heading?.innerText,
      image?.getAttribute("alt")
    ];

    return clean(candidates.find((candidate) => clean(candidate).length >= 8));
  }

  function imageFromRoot(anchor, root) {
    const image = anchor.querySelector("img") || root.querySelector("img");
    if (!image) return null;

    return (
      toUrl(image.currentSrc) ||
      toUrl(image.getAttribute("src")) ||
      toUrl(image.getAttribute("data-src")) ||
      toUrl(image.getAttribute("data-lazy-src"))
    );
  }

  function dateFromRoot(root) {
    const time =
      root.querySelector("time[datetime]") ||
      root.querySelector("[datetime]") ||
      root.querySelector("meta[itemprop='datePublished']") ||
      root.querySelector("meta[property='article:published_time']");

    const datePublished = time?.getAttribute("datetime") || time?.getAttribute("content") || null;
    const dateText = clean(time?.textContent || "");

    return {
      datePublished,
      dateText
    };
  }

  function sectionFromRoot(root) {
    const section =
      root.querySelector("[class*='section'], [class*='category'], [rel='tag']") ||
      root.closest("[class*='section'], [class*='category']");
    const label = clean(section?.textContent || "");
    return label.length <= 80 ? label : "";
  }

  function anchorCandidate(anchor, source, order) {
    const url = toUrl(anchor.getAttribute("href"));
    if (!isArticleUrl(url)) return null;

    const root = closestItemRoot(anchor);
    const title = titleFromAnchor(anchor, root);
    if (!title || title.length < 8) return null;
    if (/^(advertise|subscribe|newsletter|privacy policy)$/i.test(title)) return null;

    const date = dateFromRoot(root);
    return {
      title,
      url,
      image: imageFromRoot(anchor, root),
      section: sectionFromRoot(root),
      datePublished: date.datePublished,
      dateText: date.dateText,
      source,
      order
    };
  }

  function collectAllContentCandidates() {
    return [...document.querySelectorAll("a[href]")]
      .map((anchor, index) => anchorCandidate(anchor, "dom", index))
      .filter(Boolean);
  }

  function collectTopHeadlineCandidates() {
    const selector = [
      "[id*='top' i][id*='headline' i]",
      "[class*='top' i][class*='headline' i]",
      "[id*='headline' i]",
      "[class*='headline' i]"
    ].join(",");

    const roots = [...document.querySelectorAll(selector)].filter((root) =>
      /top\s+headlines/i.test(clean(root.textContent))
    );

    const headings = [...document.querySelectorAll("h1, h2, h3, h4, h5, [class*='title' i]")].filter((heading) =>
      /top\s+headlines/i.test(clean(heading.textContent))
    );

    for (const heading of headings) {
      const root =
        heading.closest("section, aside, [role='region'], [class*='block' i], [class*='view' i], [class*='region' i]") ||
        heading.parentElement;
      if (root) roots.push(root);
    }

    const uniqueRoots = [...new Set(roots)];
    const candidates = [];
    let order = 0;

    for (const root of uniqueRoots) {
      for (const anchor of root.querySelectorAll("a[href]")) {
        const candidate = anchorCandidate(anchor, "top-headlines", order++);
        if (candidate) candidates.push(candidate);
      }
    }

    for (const heading of headings) {
      let sibling = heading.nextElementSibling;
      let guard = 0;
      while (sibling && guard < 8 && !/^H[1-5]$/i.test(sibling.tagName)) {
        for (const anchor of sibling.querySelectorAll("a[href]")) {
          const candidate = anchorCandidate(anchor, "top-headlines-sibling", order++);
          if (candidate) candidates.push(candidate);
        }
        sibling = sibling.nextElementSibling;
        guard += 1;
      }
    }

    return candidates.length > 0 ? candidates : collectAllContentCandidates();
  }

  function isAfterElement(element, start) {
    if (!start) return true;
    return Boolean(start.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  function isBeforeElement(element, end) {
    if (!end) return true;
    return Boolean(element.compareDocumentPosition(end) & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  function collectVideoPageCandidates() {
    const headings = [...document.querySelectorAll("h1, h2, h3, h4, h5")];
    const start = headings.find((heading) => /^video$/i.test(clean(heading.textContent)));
    const end = headings.find(
      (heading) => /^(most popular|email alerts)$/i.test(clean(heading.textContent)) && isAfterElement(heading, start)
    );

    const anchors =
      start || end
        ? [...document.querySelectorAll("a[href]")].filter(
            (anchor) => isAfterElement(anchor, start) && isBeforeElement(anchor, end)
          )
        : [...document.querySelectorAll("a[href]")];

    const candidates = anchors
      .map((anchor, index) => anchorCandidate(anchor, "video-page", index))
      .filter(Boolean);

    return candidates.length > 0 ? candidates : collectAllContentCandidates();
  }

  function collectJsonLdCandidates() {
    const candidates = [];
    let order = 0;

    function typesOf(value) {
      const type = value?.["@type"];
      return Array.isArray(type) ? type : [type].filter(Boolean);
    }

    function visit(value) {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }

      const types = typesOf(value).map((type) => String(type).toLowerCase());
      if (types.some((type) => ["article", "newsarticle", "videoobject"].includes(type))) {
        const url = toUrl(value.url || value.mainEntityOfPage?.["@id"] || value.mainEntityOfPage);
        const title = clean(value.headline || value.name);
        if (url && title && isArticleUrl(url)) {
          candidates.push({
            title,
            url,
            image: Array.isArray(value.image) ? toUrl(value.image[0]?.url || value.image[0]) : toUrl(value.image?.url || value.image),
            section: clean(value.articleSection || ""),
            datePublished: value.datePublished || null,
            dateText: "",
            source: "json-ld",
            order: order++
          });
        }
      }

      if (value.itemListElement) visit(value.itemListElement);
      if (value.item) visit(value.item);
      if (value["@graph"]) visit(value["@graph"]);
    }

    for (const script of document.querySelectorAll("script[type='application/ld+json']")) {
      try {
        visit(JSON.parse(script.textContent || ""));
      } catch {
        // Ignore broken or non-JSON LD script tags.
      }
    }

    return candidates;
  }

  function dedupe(items) {
    const seen = new Set();
    const result = [];

    for (const item of items) {
      const url = toUrl(item.url);
      const title = clean(item.title);
      if (!url || !title || seen.has(url)) continue;
      seen.add(url);
      result.push({
        ...item,
        url,
        title
      });
    }

    return result;
  }

  let items;
  if (mode === "home-top-headlines") {
    items = collectTopHeadlineCandidates();
  } else if (mode === "videos") {
    items = collectVideoPageCandidates();
  } else {
    items = collectAllContentCandidates();
  }

  items = dedupe([...items, ...collectJsonLdCandidates()]);
  if (limit > 0) items = items.slice(0, limit);

  return {
    pageUrl: document.location?.href || baseUrl,
    pageTitle: document.title || "",
    challengeDetected: isChallenge(),
    itemCount: items.length,
    items,
    diagnostics: {
      mode,
      anchorCount: document.querySelectorAll("a[href]").length,
      bodyTextLength: (document.body?.innerText || "").length
    }
  };
}
