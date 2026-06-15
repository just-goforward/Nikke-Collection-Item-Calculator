function normalizeMajor(value: unknown) {
  const match = String(value || "").match(/\d+/);
  if (!match) return "unknown";
  return match[0].slice(0, 3);
}

function stripHeaderQuotes(value: string) {
  return value.trim().replace(/^"|"$/g, "");
}

function browserFromUserAgent(userAgent: string) {
  const samsung = userAgent.match(/SamsungBrowser\/(\d+)/i);
  if (samsung) return { browser: "Samsung Internet", browserMajor: normalizeMajor(samsung[1]) };
  const edge = userAgent.match(/Edg(?:e|A|iOS)?\/(\d+)/i);
  if (edge) return { browser: "Edge", browserMajor: normalizeMajor(edge[1]) };
  const firefox = userAgent.match(/(?:Firefox|FxiOS)\/(\d+)/i);
  if (firefox) return { browser: "Firefox", browserMajor: normalizeMajor(firefox[1]) };
  const chrome = userAgent.match(/(?:Chrome|CriOS|Chromium)\/(\d+)/i);
  if (chrome) return { browser: "Chrome", browserMajor: normalizeMajor(chrome[1]) };
  const safari = userAgent.match(/Version\/(\d+).+Safari\//i);
  if (safari) return { browser: "Safari", browserMajor: normalizeMajor(safari[1]) };
  return null;
}

function browserFromClientHints(header: string) {
  const brands: Array<{ brand: string; major: string }> = [];
  const pattern = /"([^"]+)";v="(\d+)/g;
  let match = pattern.exec(header);

  while (match) {
    const rawBrand = match[1];
    const rawMajor = match[2];
    if (!rawBrand || !rawMajor) {
      match = pattern.exec(header);
      continue;
    }
    const brand = rawBrand.toLowerCase();
    if (!(brand.includes("not") && brand.includes("brand"))) {
      brands.push({ brand, major: normalizeMajor(rawMajor) });
    }
    match = pattern.exec(header);
  }

  const prioritized = [
    { needle: "samsung", browser: "Samsung Internet" },
    { needle: "microsoft edge", browser: "Edge" },
    { needle: "google chrome", browser: "Chrome" },
    { needle: "chromium", browser: "Chrome" },
  ];

  for (const candidate of prioritized) {
    const brand = brands.find((item) => item.brand.includes(candidate.needle));
    if (brand) return { browser: candidate.browser, browserMajor: brand.major };
  }

  return null;
}

function osFromUserAgent(userAgent: string) {
  const android = userAgent.match(/Android\s+(\d+)/i);
  if (android) return { os: "Android", osMajor: normalizeMajor(android[1]) };
  const ios = userAgent.match(/(?:iPhone OS|CPU OS)\s+(\d+)/i);
  if (ios) return { os: "iOS", osMajor: normalizeMajor(ios[1]) };
  const windows = userAgent.match(/Windows NT\s+(\d+)/i);
  if (windows) return { os: "Windows", osMajor: normalizeMajor(windows[1]) };
  const macos = userAgent.match(/Mac OS X\s+(\d+)/i);
  if (macos) return { os: "macOS", osMajor: normalizeMajor(macos[1]) };
  const chromeos = userAgent.match(/CrOS/i);
  if (chromeos) return { os: "ChromeOS", osMajor: "unknown" };
  if (/Linux/i.test(userAgent)) return { os: "Linux", osMajor: "unknown" };
  return null;
}

function osFromClientHints(platformHeader: string, userAgent: string) {
  const platform = stripHeaderQuotes(platformHeader).toLowerCase();
  if (!platform) return null;
  const fallback = osFromUserAgent(userAgent);
  if (platform.includes("android"))
    return { os: "Android", osMajor: fallback?.osMajor || "unknown" };
  if (platform.includes("ios")) return { os: "iOS", osMajor: fallback?.osMajor || "unknown" };
  if (platform.includes("windows"))
    return { os: "Windows", osMajor: fallback?.osMajor || "unknown" };
  if (platform.includes("mac")) return { os: "macOS", osMajor: fallback?.osMajor || "unknown" };
  if (platform.includes("chrome"))
    return { os: "ChromeOS", osMajor: fallback?.osMajor || "unknown" };
  if (platform.includes("linux")) return { os: "Linux", osMajor: fallback?.osMajor || "unknown" };
  return null;
}

function deviceTypeFromHeaders(request: Request, userAgent: string) {
  if (/iPad|Tablet|PlayBook|Silk|Android(?!.*Mobile)/i.test(userAgent)) return "tablet";
  const mobileHint = request.headers.get("Sec-CH-UA-Mobile");
  if (mobileHint === "?1") return "mobile";
  if (/Mobi|Android|iPhone|iPod|Mobile/i.test(userAgent)) return "mobile";
  if (userAgent) return "desktop";
  return "unknown";
}

export function clientEnvironment(request: Request) {
  const userAgent = request.headers.get("User-Agent") || "";
  const browser = browserFromUserAgent(userAgent) ||
    browserFromClientHints(request.headers.get("Sec-CH-UA") || "") || {
      browser: "Unknown",
      browserMajor: "unknown",
    };
  const os = osFromClientHints(request.headers.get("Sec-CH-UA-Platform") || "", userAgent) ||
    osFromUserAgent(userAgent) || {
      os: "Unknown",
      osMajor: "unknown",
    };

  return {
    browser: browser.browser,
    browserMajor: browser.browserMajor,
    os: os.os,
    osMajor: os.osMajor,
    deviceType: deviceTypeFromHeaders(request, userAgent),
  };
}
