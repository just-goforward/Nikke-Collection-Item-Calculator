var Oi = Object.defineProperty, W = (e, n) => {
	let i = {};
	for (var o in e) Oi(i, o, {
		get: e[o],
		enumerable: !0
	});
	return n || Oi(i, Symbol.toStringTag, { value: "Module" }), i;
}, Ni;
const mo = Object.freeze({ status: "aborted" });
function d(e, n, i) {
	function o(u, l) {
		if (u._zod || Object.defineProperty(u, "_zod", {
			value: {
				def: l,
				constr: a,
				traits: /* @__PURE__ */ new Set()
			},
			enumerable: !1
		}), u._zod.traits.has(e)) return;
		u._zod.traits.add(e), n(u, l);
		const c = a.prototype, s = Object.keys(c);
		for (let f = 0; f < s.length; f++) {
			const m = s[f];
			m in u || (u[m] = c[m].bind(u));
		}
	}
	const t = i?.Parent ?? Object;
	class r extends t {}
	Object.defineProperty(r, "name", { value: e });
	function a(u) {
		var l;
		const c = i?.Parent ? new r() : this;
		o(c, u), (l = c._zod).deferred ?? (l.deferred = []);
		for (const s of c._zod.deferred) s();
		return c;
	}
	return Object.defineProperty(a, "init", { value: o }), Object.defineProperty(a, Symbol.hasInstance, { value: (u) => i?.Parent && u instanceof i.Parent ? !0 : u?._zod?.traits?.has(e) }), Object.defineProperty(a, "name", { value: e }), a;
}
const fo = Symbol("zod_brand");
var de = class extends Error {
	constructor() {
		super("Encountered Promise during synchronous parse. Use .parseAsync() instead.");
	}
}, Zt = class extends Error {
	constructor(e) {
		super(`Encountered unidirectional transform during encode: ${e}`), this.name = "ZodEncodeError";
	}
};
(Ni = globalThis).__zod_globalConfig ?? (Ni.__zod_globalConfig = {});
const Ee = globalThis.__zod_globalConfig;
function P(e) {
	return e && Object.assign(Ee, e), Ee;
}
var po = W({
	BIGINT_FORMAT_RANGES: () => yo,
	Class: () => Td,
	NUMBER_FORMAT_RANGES: () => bo,
	aborted: () => se,
	allowsEval: () => ho,
	assert: () => yd,
	assertEqual: () => hd,
	assertIs: () => _d,
	assertNever: () => bd,
	assertNotEqual: () => $d,
	assignProp: () => ue,
	base64ToUint8Array: () => jo,
	base64urlToUint8Array: () => Dd,
	cached: () => Me,
	captureStackTrace: () => Tn,
	cleanEnum: () => jd,
	cleanRegex: () => Ut,
	clone: () => G,
	cloneDef: () => Sd,
	createTransparentProxy: () => Ud,
	defineLazy: () => S,
	esc: () => In,
	escapeRegex: () => H,
	explicitlyAborted: () => Uo,
	extend: () => Io,
	finalizeIssue: () => R,
	floatSafeRemainder: () => vo,
	getElementAtPath: () => Id,
	getEnumValues: () => Pn,
	getLengthableOrigin: () => Ot,
	getParsedType: () => Zd,
	getSizableOrigin: () => Dt,
	hexToUint8Array: () => Nd,
	isObject: () => ye,
	isPlainObject: () => me,
	issue: () => ke,
	joinValues: () => v,
	jsonStringifyReplacer: () => bt,
	merge: () => wo,
	mergeDefs: () => X,
	normalizeParams: () => p,
	nullish: () => ve,
	numKeys: () => xd,
	objectClone: () => kd,
	omit: () => So,
	optionalKeys: () => _o,
	parsedType: () => b,
	partial: () => xo,
	pick: () => ko,
	prefixIssues: () => J,
	primitiveTypes: () => $o,
	promiseAllObject: () => zd,
	propertyKeyTypes: () => yt,
	randomString: () => wd,
	required: () => Zo,
	safeExtend: () => zo,
	shallowClone: () => jt,
	slugify: () => go,
	stringifyPrimitive: () => _,
	uint8ArrayToBase64: () => Do,
	uint8ArrayToBase64url: () => Od,
	uint8ArrayToHex: () => Pd,
	unwrapMessage: () => Pe
});
function hd(e) {
	return e;
}
function $d(e) {
	return e;
}
function _d(e) {}
function bd(e) {
	throw new Error("Unexpected value in exhaustive check");
}
function yd(e) {}
function Pn(e) {
	const n = Object.values(e).filter((i) => typeof i == "number");
	return Object.entries(e).filter(([i, o]) => n.indexOf(+i) === -1).map(([i, o]) => o);
}
function v(e, n = "|") {
	return e.map((i) => _(i)).join(n);
}
function bt(e, n) {
	return typeof n == "bigint" ? n.toString() : n;
}
function Me(e) {
	return { get value() {
		{
			const n = e();
			return Object.defineProperty(this, "value", { value: n }), n;
		}
		throw new Error("cached value already set");
	} };
}
function ve(e) {
	return e == null;
}
function Ut(e) {
	const n = e.startsWith("^") ? 1 : 0, i = e.endsWith("$") ? e.length - 1 : e.length;
	return e.slice(n, i);
}
function vo(e, n) {
	const i = e / n, o = Math.round(i), t = Number.EPSILON * Math.max(Math.abs(i), 1);
	return Math.abs(i - o) < t ? 0 : i - o;
}
const Pi = Symbol("evaluating");
function S(e, n, i) {
	let o;
	Object.defineProperty(e, n, {
		get() {
			if (o !== Pi) return o === void 0 && (o = Pi, o = i()), o;
		},
		set(t) {
			Object.defineProperty(e, n, { value: t });
		},
		configurable: !0
	});
}
function kd(e) {
	return Object.create(Object.getPrototypeOf(e), Object.getOwnPropertyDescriptors(e));
}
function ue(e, n, i) {
	Object.defineProperty(e, n, {
		value: i,
		writable: !0,
		enumerable: !0,
		configurable: !0
	});
}
function X(...e) {
	const n = {};
	for (const i of e) Object.assign(n, Object.getOwnPropertyDescriptors(i));
	return Object.defineProperties({}, n);
}
function Sd(e) {
	return X(e._zod.def);
}
function Id(e, n) {
	return n ? n.reduce((i, o) => i?.[o], e) : e;
}
function zd(e) {
	const n = Object.keys(e), i = n.map((o) => e[o]);
	return Promise.all(i).then((o) => {
		const t = {};
		for (let r = 0; r < n.length; r++) t[n[r]] = o[r];
		return t;
	});
}
function wd(e = 10) {
	const n = "abcdefghijklmnopqrstuvwxyz";
	let i = "";
	for (let o = 0; o < e; o++) i += n[Math.floor(Math.random() * 26)];
	return i;
}
function In(e) {
	return JSON.stringify(e);
}
function go(e) {
	return e.toLowerCase().trim().replace(/[^\w\s-]/g, "").replace(/[\s_-]+/g, "-").replace(/^-+|-+$/g, "");
}
const Tn = "captureStackTrace" in Error ? Error.captureStackTrace : (...e) => {};
function ye(e) {
	return typeof e == "object" && e !== null && !Array.isArray(e);
}
const ho = Me(() => {
	if (Ee.jitless || typeof navigator < "u" && navigator?.userAgent?.includes("Cloudflare")) return !1;
	try {
		return new Function(""), !0;
	} catch {
		return !1;
	}
});
function me(e) {
	if (ye(e) === !1) return !1;
	const n = e.constructor;
	if (n === void 0 || typeof n != "function") return !0;
	const i = n.prototype;
	return !(ye(i) === !1 || Object.prototype.hasOwnProperty.call(i, "isPrototypeOf") === !1);
}
function jt(e) {
	return me(e) ? { ...e } : Array.isArray(e) ? [...e] : e instanceof Map ? new Map(e) : e instanceof Set ? new Set(e) : e;
}
function xd(e) {
	let n = 0;
	for (const i in e) Object.prototype.hasOwnProperty.call(e, i) && n++;
	return n;
}
const Zd = (e) => {
	const n = typeof e;
	switch (n) {
		case "undefined": return "undefined";
		case "string": return "string";
		case "number": return Number.isNaN(e) ? "nan" : "number";
		case "boolean": return "boolean";
		case "function": return "function";
		case "bigint": return "bigint";
		case "symbol": return "symbol";
		case "object": return Array.isArray(e) ? "array" : e === null ? "null" : e.then && typeof e.then == "function" && e.catch && typeof e.catch == "function" ? "promise" : typeof Map < "u" && e instanceof Map ? "map" : typeof Set < "u" && e instanceof Set ? "set" : typeof Date < "u" && e instanceof Date ? "date" : typeof File < "u" && e instanceof File ? "file" : "object";
		default: throw new Error(`Unknown data type: ${n}`);
	}
}, yt = new Set([
	"string",
	"number",
	"symbol"
]), $o = new Set([
	"string",
	"number",
	"bigint",
	"boolean",
	"symbol",
	"undefined"
]);
function H(e) {
	return e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function G(e, n, i) {
	const o = new e._zod.constr(n ?? e._zod.def);
	return (!n || i?.parent) && (o._zod.parent = e), o;
}
function p(e) {
	const n = e;
	if (!n) return {};
	if (typeof n == "string") return { error: () => n };
	if (n?.message !== void 0) {
		if (n?.error !== void 0) throw new Error("Cannot specify both `message` and `error` params");
		n.error = n.message;
	}
	return delete n.message, typeof n.error == "string" ? {
		...n,
		error: () => n.error
	} : n;
}
function Ud(e) {
	let n;
	return new Proxy({}, {
		get(i, o, t) {
			return n ?? (n = e()), Reflect.get(n, o, t);
		},
		set(i, o, t, r) {
			return n ?? (n = e()), Reflect.set(n, o, t, r);
		},
		has(i, o) {
			return n ?? (n = e()), Reflect.has(n, o);
		},
		deleteProperty(i, o) {
			return n ?? (n = e()), Reflect.deleteProperty(n, o);
		},
		ownKeys(i) {
			return n ?? (n = e()), Reflect.ownKeys(n);
		},
		getOwnPropertyDescriptor(i, o) {
			return n ?? (n = e()), Reflect.getOwnPropertyDescriptor(n, o);
		},
		defineProperty(i, o, t) {
			return n ?? (n = e()), Reflect.defineProperty(n, o, t);
		}
	});
}
function _(e) {
	return typeof e == "bigint" ? e.toString() + "n" : typeof e == "string" ? `"${e}"` : `${e}`;
}
function _o(e) {
	return Object.keys(e).filter((n) => e[n]._zod.optin === "optional" && e[n]._zod.optout === "optional");
}
const bo = {
	safeint: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
	int32: [-2147483648, 2147483647],
	uint32: [0, 4294967295],
	float32: [-34028234663852886e22, 34028234663852886e22],
	float64: [-Number.MAX_VALUE, Number.MAX_VALUE]
}, yo = {
	int64: [BigInt("-9223372036854775808"), BigInt("9223372036854775807")],
	uint64: [BigInt(0), BigInt("18446744073709551615")]
};
function ko(e, n) {
	const i = e._zod.def, o = i.checks;
	if (o && o.length > 0) throw new Error(".pick() cannot be used on object schemas containing refinements");
	return G(e, X(e._zod.def, {
		get shape() {
			const t = {};
			for (const r in n) {
				if (!(r in i.shape)) throw new Error(`Unrecognized key: "${r}"`);
				n[r] && (t[r] = i.shape[r]);
			}
			return ue(this, "shape", t), t;
		},
		checks: []
	}));
}
function So(e, n) {
	const i = e._zod.def, o = i.checks;
	if (o && o.length > 0) throw new Error(".omit() cannot be used on object schemas containing refinements");
	return G(e, X(e._zod.def, {
		get shape() {
			const t = { ...e._zod.def.shape };
			for (const r in n) {
				if (!(r in i.shape)) throw new Error(`Unrecognized key: "${r}"`);
				n[r] && delete t[r];
			}
			return ue(this, "shape", t), t;
		},
		checks: []
	}));
}
function Io(e, n) {
	if (!me(n)) throw new Error("Invalid input to extend: expected a plain object");
	const i = e._zod.def.checks;
	if (i && i.length > 0) {
		const o = e._zod.def.shape;
		for (const t in n) if (Object.getOwnPropertyDescriptor(o, t) !== void 0) throw new Error("Cannot overwrite keys on object schemas containing refinements. Use `.safeExtend()` instead.");
	}
	return G(e, X(e._zod.def, { get shape() {
		const o = {
			...e._zod.def.shape,
			...n
		};
		return ue(this, "shape", o), o;
	} }));
}
function zo(e, n) {
	if (!me(n)) throw new Error("Invalid input to safeExtend: expected a plain object");
	return G(e, X(e._zod.def, { get shape() {
		const i = {
			...e._zod.def.shape,
			...n
		};
		return ue(this, "shape", i), i;
	} }));
}
function wo(e, n) {
	if (e._zod.def.checks?.length) throw new Error(".merge() cannot be used on object schemas containing refinements. Use .safeExtend() instead.");
	return G(e, X(e._zod.def, {
		get shape() {
			const i = {
				...e._zod.def.shape,
				...n._zod.def.shape
			};
			return ue(this, "shape", i), i;
		},
		get catchall() {
			return n._zod.def.catchall;
		},
		checks: n._zod.def.checks ?? []
	}));
}
function xo(e, n, i) {
	const o = n._zod.def.checks;
	if (o && o.length > 0) throw new Error(".partial() cannot be used on object schemas containing refinements");
	return G(n, X(n._zod.def, {
		get shape() {
			const t = n._zod.def.shape, r = { ...t };
			if (i) for (const a in i) {
				if (!(a in t)) throw new Error(`Unrecognized key: "${a}"`);
				i[a] && (r[a] = e ? new e({
					type: "optional",
					innerType: t[a]
				}) : t[a]);
			}
			else for (const a in t) r[a] = e ? new e({
				type: "optional",
				innerType: t[a]
			}) : t[a];
			return ue(this, "shape", r), r;
		},
		checks: []
	}));
}
function Zo(e, n, i) {
	return G(n, X(n._zod.def, { get shape() {
		const o = n._zod.def.shape, t = { ...o };
		if (i) for (const r in i) {
			if (!(r in t)) throw new Error(`Unrecognized key: "${r}"`);
			i[r] && (t[r] = new e({
				type: "nonoptional",
				innerType: o[r]
			}));
		}
		else for (const r in o) t[r] = new e({
			type: "nonoptional",
			innerType: o[r]
		});
		return ue(this, "shape", t), t;
	} }));
}
function se(e, n = 0) {
	if (e.aborted === !0) return !0;
	for (let i = n; i < e.issues.length; i++) if (e.issues[i]?.continue !== !0) return !0;
	return !1;
}
function Uo(e, n = 0) {
	if (e.aborted === !0) return !0;
	for (let i = n; i < e.issues.length; i++) if (e.issues[i]?.continue === !1) return !0;
	return !1;
}
function J(e, n) {
	return n.map((i) => {
		var o;
		return (o = i).path ?? (o.path = []), i.path.unshift(e), i;
	});
}
function Pe(e) {
	return typeof e == "string" ? e : e?.message;
}
function R(e, n, i) {
	const o = e.message ? e.message : Pe(e.inst?._zod.def?.error?.(e)) ?? Pe(n?.error?.(e)) ?? Pe(i.customError?.(e)) ?? Pe(i.localeError?.(e)) ?? "Invalid input", { inst: t, continue: r, input: a, ...u } = e;
	return u.path ?? (u.path = []), u.message = o, n?.reportInput && (u.input = a), u;
}
function Dt(e) {
	return e instanceof Set ? "set" : e instanceof Map ? "map" : e instanceof File ? "file" : "unknown";
}
function Ot(e) {
	return Array.isArray(e) ? "array" : typeof e == "string" ? "string" : "unknown";
}
function b(e) {
	const n = typeof e;
	switch (n) {
		case "number": return Number.isNaN(e) ? "nan" : "number";
		case "object": {
			if (e === null) return "null";
			if (Array.isArray(e)) return "array";
			const i = e;
			if (i && Object.getPrototypeOf(i) !== Object.prototype && "constructor" in i && i.constructor) return i.constructor.name;
		}
	}
	return n;
}
function ke(...e) {
	const [n, i, o] = e;
	return typeof n == "string" ? {
		message: n,
		code: "custom",
		input: i,
		inst: o
	} : { ...n };
}
function jd(e) {
	return Object.entries(e).filter(([n, i]) => Number.isNaN(Number.parseInt(n, 10))).map((n) => n[1]);
}
function jo(e) {
	const n = atob(e), i = new Uint8Array(n.length);
	for (let o = 0; o < n.length; o++) i[o] = n.charCodeAt(o);
	return i;
}
function Do(e) {
	let n = "";
	for (let i = 0; i < e.length; i++) n += String.fromCharCode(e[i]);
	return btoa(n);
}
function Dd(e) {
	const n = e.replace(/-/g, "+").replace(/_/g, "/");
	return jo(n + "=".repeat((4 - n.length % 4) % 4));
}
function Od(e) {
	return Do(e).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
function Nd(e) {
	const n = e.replace(/^0x/, "");
	if (n.length % 2 !== 0) throw new Error("Invalid hex string length");
	const i = new Uint8Array(n.length / 2);
	for (let o = 0; o < n.length; o += 2) i[o / 2] = Number.parseInt(n.slice(o, o + 2), 16);
	return i;
}
function Pd(e) {
	return Array.from(e).map((n) => n.toString(16).padStart(2, "0")).join("");
}
var Td = class {
	constructor(...e) {}
};
const Oo = (e, n) => {
	e.name = "$ZodError", Object.defineProperty(e, "_zod", {
		value: e._zod,
		enumerable: !1
	}), Object.defineProperty(e, "issues", {
		value: n,
		enumerable: !1
	}), e.message = JSON.stringify(n, bt, 2), Object.defineProperty(e, "toString", {
		value: () => e.message,
		enumerable: !1
	});
}, En = d("$ZodError", Oo), L = d("$ZodError", Oo, { Parent: Error });
function An(e, n = (i) => i.message) {
	const i = {}, o = [];
	for (const t of e.issues) t.path.length > 0 ? (i[t.path[0]] = i[t.path[0]] || [], i[t.path[0]].push(n(t))) : o.push(n(t));
	return {
		formErrors: o,
		fieldErrors: i
	};
}
function Cn(e, n = (i) => i.message) {
	const i = { _errors: [] }, o = (t, r = []) => {
		for (const a of t.issues) if (a.code === "invalid_union" && a.errors.length) a.errors.map((u) => o({ issues: u }, [...r, ...a.path]));
		else if (a.code === "invalid_key") o({ issues: a.issues }, [...r, ...a.path]);
		else if (a.code === "invalid_element") o({ issues: a.issues }, [...r, ...a.path]);
		else {
			const u = [...r, ...a.path];
			if (u.length === 0) i._errors.push(n(a));
			else {
				let l = i, c = 0;
				for (; c < u.length;) {
					const s = u[c];
					c !== u.length - 1 ? l[s] = l[s] || { _errors: [] } : (l[s] = l[s] || { _errors: [] }, l[s]._errors.push(n(a))), l = l[s], c++;
				}
			}
		}
	};
	return o(e), i;
}
function No(e, n = (i) => i.message) {
	const i = { errors: [] }, o = (t, r = []) => {
		var a, u;
		for (const l of t.issues) if (l.code === "invalid_union" && l.errors.length) l.errors.map((c) => o({ issues: c }, [...r, ...l.path]));
		else if (l.code === "invalid_key") o({ issues: l.issues }, [...r, ...l.path]);
		else if (l.code === "invalid_element") o({ issues: l.issues }, [...r, ...l.path]);
		else {
			const c = [...r, ...l.path];
			if (c.length === 0) {
				i.errors.push(n(l));
				continue;
			}
			let s = i, f = 0;
			for (; f < c.length;) {
				const m = c[f], g = f === c.length - 1;
				typeof m == "string" ? (s.properties ?? (s.properties = {}), (a = s.properties)[m] ?? (a[m] = { errors: [] }), s = s.properties[m]) : (s.items ?? (s.items = []), (u = s.items)[m] ?? (u[m] = { errors: [] }), s = s.items[m]), g && s.errors.push(n(l)), f++;
			}
		}
	};
	return o(e), i;
}
function Po(e) {
	const n = [], i = e.map((o) => typeof o == "object" ? o.key : o);
	for (const o of i) typeof o == "number" ? n.push(`[${o}]`) : typeof o == "symbol" ? n.push(`[${JSON.stringify(String(o))}]`) : /[^\w$]/.test(o) ? n.push(`[${JSON.stringify(o)}]`) : (n.length && n.push("."), n.push(o));
	return n.join("");
}
function To(e) {
	const n = [], i = [...e.issues].sort((o, t) => (o.path ?? []).length - (t.path ?? []).length);
	for (const o of i) n.push(`✖ ${o.message}`), o.path?.length && n.push(`  → at ${Po(o.path)}`);
	return n.join(`
`);
}
const Ke = (e) => (n, i, o, t) => {
	const r = o ? {
		...o,
		async: !1
	} : { async: !1 }, a = n._zod.run({
		value: i,
		issues: []
	}, r);
	if (a instanceof Promise) throw new de();
	if (a.issues.length) {
		const u = new (t?.Err ?? e)(a.issues.map((l) => R(l, r, P())));
		throw Tn(u, t?.callee), u;
	}
	return a.value;
}, zn = Ke(L), Ge = (e) => async (n, i, o, t) => {
	const r = o ? {
		...o,
		async: !0
	} : { async: !0 };
	let a = n._zod.run({
		value: i,
		issues: []
	}, r);
	if (a instanceof Promise && (a = await a), a.issues.length) {
		const u = new (t?.Err ?? e)(a.issues.map((l) => R(l, r, P())));
		throw Tn(u, t?.callee), u;
	}
	return a.value;
}, wn = Ge(L), Ve = (e) => (n, i, o) => {
	const t = o ? {
		...o,
		async: !1
	} : { async: !1 }, r = n._zod.run({
		value: i,
		issues: []
	}, t);
	if (r instanceof Promise) throw new de();
	return r.issues.length ? {
		success: !1,
		error: new (e ?? En)(r.issues.map((a) => R(a, t, P())))
	} : {
		success: !0,
		data: r.value
	};
}, Eo = Ve(L), Be = (e) => async (n, i, o) => {
	const t = o ? {
		...o,
		async: !0
	} : { async: !0 };
	let r = n._zod.run({
		value: i,
		issues: []
	}, t);
	return r instanceof Promise && (r = await r), r.issues.length ? {
		success: !1,
		error: new e(r.issues.map((a) => R(a, t, P())))
	} : {
		success: !0,
		data: r.value
	};
}, Ao = Be(L), Rn = (e) => (n, i, o) => {
	const t = o ? {
		...o,
		direction: "backward"
	} : { direction: "backward" };
	return Ke(e)(n, i, t);
}, Ed = Rn(L), Ln = (e) => (n, i, o) => Ke(e)(n, i, o), Ad = Ln(L), Fn = (e) => async (n, i, o) => {
	const t = o ? {
		...o,
		direction: "backward"
	} : { direction: "backward" };
	return Ge(e)(n, i, t);
}, Cd = Fn(L), Jn = (e) => async (n, i, o) => Ge(e)(n, i, o), Rd = Jn(L), Mn = (e) => (n, i, o) => {
	const t = o ? {
		...o,
		direction: "backward"
	} : { direction: "backward" };
	return Ve(e)(n, i, t);
}, Ld = Mn(L), Kn = (e) => (n, i, o) => Ve(e)(n, i, o), Fd = Kn(L), Gn = (e) => async (n, i, o) => {
	const t = o ? {
		...o,
		direction: "backward"
	} : { direction: "backward" };
	return Be(e)(n, i, t);
}, Jd = Gn(L), Vn = (e) => async (n, i, o) => Be(e)(n, i, o), Md = Vn(L);
var Bn = W({
	base64: () => ea,
	base64url: () => Wn,
	bigint: () => sa,
	boolean: () => ma,
	browserEmail: () => Yd,
	cidrv4: () => Ho,
	cidrv6: () => Qo,
	cuid: () => Co,
	cuid2: () => Ro,
	date: () => oa,
	datetime: () => ca,
	domain: () => na,
	duration: () => Ko,
	e164: () => ra,
	email: () => Vo,
	emoji: () => Wo,
	extendedDuration: () => Kd,
	guid: () => Go,
	hex: () => ha,
	hostname: () => ta,
	html5Email: () => Wd,
	httpProtocol: () => Xn,
	idnEmail: () => qd,
	integer: () => da,
	ipv4: () => Xo,
	ipv6: () => qo,
	ksuid: () => Jo,
	lowercase: () => va,
	mac: () => Yo,
	md5_base64: () => em,
	md5_base64url: () => tm,
	md5_hex: () => Qd,
	nanoid: () => Mo,
	null: () => fa,
	number: () => qn,
	rfc5322Email: () => Xd,
	sha1_base64: () => rm,
	sha1_base64url: () => im,
	sha1_hex: () => nm,
	sha256_base64: () => am,
	sha256_base64url: () => um,
	sha256_hex: () => om,
	sha384_base64: () => lm,
	sha384_base64url: () => sm,
	sha384_hex: () => cm,
	sha512_base64: () => mm,
	sha512_base64url: () => fm,
	sha512_hex: () => dm,
	string: () => la,
	time: () => ua,
	ulid: () => Lo,
	undefined: () => pa,
	unicodeEmail: () => Bo,
	uppercase: () => ga,
	uuid: () => Se,
	uuid4: () => Gd,
	uuid6: () => Vd,
	uuid7: () => Bd,
	xid: () => Fo
});
const Co = /^[cC][0-9a-z]{6,}$/, Ro = /^[0-9a-z]+$/, Lo = /^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/, Fo = /^[0-9a-vA-V]{20}$/, Jo = /^[A-Za-z0-9]{27}$/, Mo = /^[a-zA-Z0-9_-]{21}$/, Ko = /^P(?:(\d+W)|(?!.*W)(?=\d|T\d)(\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+([.,]\d+)?S)?)?)$/, Kd = /^[-+]?P(?!$)(?:(?:[-+]?\d+Y)|(?:[-+]?\d+[.,]\d+Y$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:(?:[-+]?\d+W)|(?:[-+]?\d+[.,]\d+W$))?(?:(?:[-+]?\d+D)|(?:[-+]?\d+[.,]\d+D$))?(?:T(?=[\d+-])(?:(?:[-+]?\d+H)|(?:[-+]?\d+[.,]\d+H$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:[-+]?\d+(?:[.,]\d+)?S)?)??$/, Go = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/, Se = (e) => e ? new RegExp(`^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-${e}[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$`) : /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/, Gd = Se(4), Vd = Se(6), Bd = Se(7), Vo = /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/, Wd = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/, Xd = /^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/, Bo = /^[^\s@"]{1,64}@[^\s@]{1,255}$/u, qd = Bo, Yd = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/, Hd = "^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$";
function Wo() {
	return new RegExp(Hd, "u");
}
const Xo = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/, qo = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))$/, Yo = (e) => {
	const n = H(e ?? ":");
	return new RegExp(`^(?:[0-9A-F]{2}${n}){5}[0-9A-F]{2}$|^(?:[0-9a-f]{2}${n}){5}[0-9a-f]{2}$`);
}, Ho = /^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/([0-9]|[1-2][0-9]|3[0-2])$/, Qo = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|::|([0-9a-fA-F]{1,4})?::([0-9a-fA-F]{1,4}:?){0,6})\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/, ea = /^$|^(?:[0-9a-zA-Z+/]{4})*(?:(?:[0-9a-zA-Z+/]{2}==)|(?:[0-9a-zA-Z+/]{3}=))?$/, Wn = /^[A-Za-z0-9_-]*$/, ta = /^(?=.{1,253}\.?$)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[-0-9a-zA-Z]{0,61}[0-9a-zA-Z])?)*\.?$/, na = /^([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/, Xn = /^https?$/, ra = /^\+[1-9]\d{6,14}$/, ia = "(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))", oa = new RegExp(`^${ia}$`);
function aa(e) {
	const n = "(?:[01]\\d|2[0-3]):[0-5]\\d";
	return typeof e.precision == "number" ? e.precision === -1 ? `${n}` : e.precision === 0 ? `${n}:[0-5]\\d` : `${n}:[0-5]\\d\\.\\d{${e.precision}}` : `${n}(?::[0-5]\\d(?:\\.\\d+)?)?`;
}
function ua(e) {
	return new RegExp(`^${aa(e)}$`);
}
function ca(e) {
	const n = aa({ precision: e.precision }), i = ["Z"];
	e.local && i.push(""), e.offset && i.push("([+-](?:[01]\\d|2[0-3]):[0-5]\\d)");
	const o = `${n}(?:${i.join("|")})`;
	return new RegExp(`^${ia}T(?:${o})$`);
}
const la = (e) => {
	const n = e ? `[\\s\\S]{${e?.minimum ?? 0},${e?.maximum ?? ""}}` : "[\\s\\S]*";
	return new RegExp(`^${n}$`);
}, sa = /^-?\d+n?$/, da = /^-?\d+$/, qn = /^-?\d+(?:\.\d+)?$/, ma = /^(?:true|false)$/i, fa = /^null$/i, pa = /^undefined$/i, va = /^[^A-Z]*$/, ga = /^[^a-z]*$/, ha = /^[0-9a-fA-F]*$/;
function We(e, n) {
	return new RegExp(`^[A-Za-z0-9+/]{${e}}${n}$`);
}
function Xe(e) {
	return new RegExp(`^[A-Za-z0-9_-]{${e}}$`);
}
const Qd = /^[0-9a-fA-F]{32}$/, em = We(22, "=="), tm = Xe(22), nm = /^[0-9a-fA-F]{40}$/, rm = We(27, "="), im = Xe(27), om = /^[0-9a-fA-F]{64}$/, am = We(43, "="), um = Xe(43), cm = /^[0-9a-fA-F]{96}$/, lm = We(64, ""), sm = Xe(64), dm = /^[0-9a-fA-F]{128}$/, mm = We(86, "=="), fm = Xe(86), D = d("$ZodCheck", (e, n) => {
	var i;
	e._zod ?? (e._zod = {}), e._zod.def = n, (i = e._zod).onattach ?? (i.onattach = []);
}), $a = {
	number: "number",
	bigint: "bigint",
	object: "date"
}, Yn = d("$ZodCheckLessThan", (e, n) => {
	D.init(e, n);
	const i = $a[typeof n.value];
	e._zod.onattach.push((o) => {
		const t = o._zod.bag, r = (n.inclusive ? t.maximum : t.exclusiveMaximum) ?? Number.POSITIVE_INFINITY;
		n.value < r && (n.inclusive ? t.maximum = n.value : t.exclusiveMaximum = n.value);
	}), e._zod.check = (o) => {
		(n.inclusive ? o.value <= n.value : o.value < n.value) || o.issues.push({
			origin: i,
			code: "too_big",
			maximum: typeof n.value == "object" ? n.value.getTime() : n.value,
			input: o.value,
			inclusive: n.inclusive,
			inst: e,
			continue: !n.abort
		});
	};
}), Hn = d("$ZodCheckGreaterThan", (e, n) => {
	D.init(e, n);
	const i = $a[typeof n.value];
	e._zod.onattach.push((o) => {
		const t = o._zod.bag, r = (n.inclusive ? t.minimum : t.exclusiveMinimum) ?? Number.NEGATIVE_INFINITY;
		n.value > r && (n.inclusive ? t.minimum = n.value : t.exclusiveMinimum = n.value);
	}), e._zod.check = (o) => {
		(n.inclusive ? o.value >= n.value : o.value > n.value) || o.issues.push({
			origin: i,
			code: "too_small",
			minimum: typeof n.value == "object" ? n.value.getTime() : n.value,
			input: o.value,
			inclusive: n.inclusive,
			inst: e,
			continue: !n.abort
		});
	};
}), _a = d("$ZodCheckMultipleOf", (e, n) => {
	D.init(e, n), e._zod.onattach.push((i) => {
		var o;
		(o = i._zod.bag).multipleOf ?? (o.multipleOf = n.value);
	}), e._zod.check = (i) => {
		if (typeof i.value != typeof n.value) throw new Error("Cannot mix number and bigint in multiple_of check.");
		(typeof i.value == "bigint" ? i.value % n.value === BigInt(0) : vo(i.value, n.value) === 0) || i.issues.push({
			origin: typeof i.value,
			code: "not_multiple_of",
			divisor: n.value,
			input: i.value,
			inst: e,
			continue: !n.abort
		});
	};
}), ba = d("$ZodCheckNumberFormat", (e, n) => {
	D.init(e, n), n.format = n.format || "float64";
	const i = n.format?.includes("int"), o = i ? "int" : "number", [t, r] = bo[n.format];
	e._zod.onattach.push((a) => {
		const u = a._zod.bag;
		u.format = n.format, u.minimum = t, u.maximum = r, i && (u.pattern = da);
	}), e._zod.check = (a) => {
		const u = a.value;
		if (i) {
			if (!Number.isInteger(u)) {
				a.issues.push({
					expected: o,
					format: n.format,
					code: "invalid_type",
					continue: !1,
					input: u,
					inst: e
				});
				return;
			}
			if (!Number.isSafeInteger(u)) {
				u > 0 ? a.issues.push({
					input: u,
					code: "too_big",
					maximum: Number.MAX_SAFE_INTEGER,
					note: "Integers must be within the safe integer range.",
					inst: e,
					origin: o,
					inclusive: !0,
					continue: !n.abort
				}) : a.issues.push({
					input: u,
					code: "too_small",
					minimum: Number.MIN_SAFE_INTEGER,
					note: "Integers must be within the safe integer range.",
					inst: e,
					origin: o,
					inclusive: !0,
					continue: !n.abort
				});
				return;
			}
		}
		u < t && a.issues.push({
			origin: "number",
			input: u,
			code: "too_small",
			minimum: t,
			inclusive: !0,
			inst: e,
			continue: !n.abort
		}), u > r && a.issues.push({
			origin: "number",
			input: u,
			code: "too_big",
			maximum: r,
			inclusive: !0,
			inst: e,
			continue: !n.abort
		});
	};
}), ya = d("$ZodCheckBigIntFormat", (e, n) => {
	D.init(e, n);
	const [i, o] = yo[n.format];
	e._zod.onattach.push((t) => {
		const r = t._zod.bag;
		r.format = n.format, r.minimum = i, r.maximum = o;
	}), e._zod.check = (t) => {
		const r = t.value;
		r < i && t.issues.push({
			origin: "bigint",
			input: r,
			code: "too_small",
			minimum: i,
			inclusive: !0,
			inst: e,
			continue: !n.abort
		}), r > o && t.issues.push({
			origin: "bigint",
			input: r,
			code: "too_big",
			maximum: o,
			inclusive: !0,
			inst: e,
			continue: !n.abort
		});
	};
}), ka = d("$ZodCheckMaxSize", (e, n) => {
	var i;
	D.init(e, n), (i = e._zod.def).when ?? (i.when = (o) => {
		const t = o.value;
		return !ve(t) && t.size !== void 0;
	}), e._zod.onattach.push((o) => {
		const t = o._zod.bag.maximum ?? Number.POSITIVE_INFINITY;
		n.maximum < t && (o._zod.bag.maximum = n.maximum);
	}), e._zod.check = (o) => {
		const t = o.value;
		t.size <= n.maximum || o.issues.push({
			origin: Dt(t),
			code: "too_big",
			maximum: n.maximum,
			inclusive: !0,
			input: t,
			inst: e,
			continue: !n.abort
		});
	};
}), Sa = d("$ZodCheckMinSize", (e, n) => {
	var i;
	D.init(e, n), (i = e._zod.def).when ?? (i.when = (o) => {
		const t = o.value;
		return !ve(t) && t.size !== void 0;
	}), e._zod.onattach.push((o) => {
		const t = o._zod.bag.minimum ?? Number.NEGATIVE_INFINITY;
		n.minimum > t && (o._zod.bag.minimum = n.minimum);
	}), e._zod.check = (o) => {
		const t = o.value;
		t.size >= n.minimum || o.issues.push({
			origin: Dt(t),
			code: "too_small",
			minimum: n.minimum,
			inclusive: !0,
			input: t,
			inst: e,
			continue: !n.abort
		});
	};
}), Ia = d("$ZodCheckSizeEquals", (e, n) => {
	var i;
	D.init(e, n), (i = e._zod.def).when ?? (i.when = (o) => {
		const t = o.value;
		return !ve(t) && t.size !== void 0;
	}), e._zod.onattach.push((o) => {
		const t = o._zod.bag;
		t.minimum = n.size, t.maximum = n.size, t.size = n.size;
	}), e._zod.check = (o) => {
		const t = o.value, r = t.size;
		if (r === n.size) return;
		const a = r > n.size;
		o.issues.push({
			origin: Dt(t),
			...a ? {
				code: "too_big",
				maximum: n.size
			} : {
				code: "too_small",
				minimum: n.size
			},
			inclusive: !0,
			exact: !0,
			input: o.value,
			inst: e,
			continue: !n.abort
		});
	};
}), za = d("$ZodCheckMaxLength", (e, n) => {
	var i;
	D.init(e, n), (i = e._zod.def).when ?? (i.when = (o) => {
		const t = o.value;
		return !ve(t) && t.length !== void 0;
	}), e._zod.onattach.push((o) => {
		const t = o._zod.bag.maximum ?? Number.POSITIVE_INFINITY;
		n.maximum < t && (o._zod.bag.maximum = n.maximum);
	}), e._zod.check = (o) => {
		const t = o.value;
		if (t.length <= n.maximum) return;
		const r = Ot(t);
		o.issues.push({
			origin: r,
			code: "too_big",
			maximum: n.maximum,
			inclusive: !0,
			input: t,
			inst: e,
			continue: !n.abort
		});
	};
}), wa = d("$ZodCheckMinLength", (e, n) => {
	var i;
	D.init(e, n), (i = e._zod.def).when ?? (i.when = (o) => {
		const t = o.value;
		return !ve(t) && t.length !== void 0;
	}), e._zod.onattach.push((o) => {
		const t = o._zod.bag.minimum ?? Number.NEGATIVE_INFINITY;
		n.minimum > t && (o._zod.bag.minimum = n.minimum);
	}), e._zod.check = (o) => {
		const t = o.value;
		if (t.length >= n.minimum) return;
		const r = Ot(t);
		o.issues.push({
			origin: r,
			code: "too_small",
			minimum: n.minimum,
			inclusive: !0,
			input: t,
			inst: e,
			continue: !n.abort
		});
	};
}), xa = d("$ZodCheckLengthEquals", (e, n) => {
	var i;
	D.init(e, n), (i = e._zod.def).when ?? (i.when = (o) => {
		const t = o.value;
		return !ve(t) && t.length !== void 0;
	}), e._zod.onattach.push((o) => {
		const t = o._zod.bag;
		t.minimum = n.length, t.maximum = n.length, t.length = n.length;
	}), e._zod.check = (o) => {
		const t = o.value, r = t.length;
		if (r === n.length) return;
		const a = Ot(t), u = r > n.length;
		o.issues.push({
			origin: a,
			...u ? {
				code: "too_big",
				maximum: n.length
			} : {
				code: "too_small",
				minimum: n.length
			},
			inclusive: !0,
			exact: !0,
			input: o.value,
			inst: e,
			continue: !n.abort
		});
	};
}), qe = d("$ZodCheckStringFormat", (e, n) => {
	var i, o;
	D.init(e, n), e._zod.onattach.push((t) => {
		const r = t._zod.bag;
		r.format = n.format, n.pattern && (r.patterns ?? (r.patterns = /* @__PURE__ */ new Set()), r.patterns.add(n.pattern));
	}), n.pattern ? (i = e._zod).check ?? (i.check = (t) => {
		n.pattern.lastIndex = 0, !n.pattern.test(t.value) && t.issues.push({
			origin: "string",
			code: "invalid_format",
			format: n.format,
			input: t.value,
			...n.pattern ? { pattern: n.pattern.toString() } : {},
			inst: e,
			continue: !n.abort
		});
	}) : (o = e._zod).check ?? (o.check = () => {});
}), Za = d("$ZodCheckRegex", (e, n) => {
	qe.init(e, n), e._zod.check = (i) => {
		n.pattern.lastIndex = 0, !n.pattern.test(i.value) && i.issues.push({
			origin: "string",
			code: "invalid_format",
			format: "regex",
			input: i.value,
			pattern: n.pattern.toString(),
			inst: e,
			continue: !n.abort
		});
	};
}), Ua = d("$ZodCheckLowerCase", (e, n) => {
	n.pattern ?? (n.pattern = va), qe.init(e, n);
}), ja = d("$ZodCheckUpperCase", (e, n) => {
	n.pattern ?? (n.pattern = ga), qe.init(e, n);
}), Da = d("$ZodCheckIncludes", (e, n) => {
	D.init(e, n);
	const i = H(n.includes), o = new RegExp(typeof n.position == "number" ? `^.{${n.position}}${i}` : i);
	n.pattern = o, e._zod.onattach.push((t) => {
		const r = t._zod.bag;
		r.patterns ?? (r.patterns = /* @__PURE__ */ new Set()), r.patterns.add(o);
	}), e._zod.check = (t) => {
		t.value.includes(n.includes, n.position) || t.issues.push({
			origin: "string",
			code: "invalid_format",
			format: "includes",
			includes: n.includes,
			input: t.value,
			inst: e,
			continue: !n.abort
		});
	};
}), Oa = d("$ZodCheckStartsWith", (e, n) => {
	D.init(e, n);
	const i = new RegExp(`^${H(n.prefix)}.*`);
	n.pattern ?? (n.pattern = i), e._zod.onattach.push((o) => {
		const t = o._zod.bag;
		t.patterns ?? (t.patterns = /* @__PURE__ */ new Set()), t.patterns.add(i);
	}), e._zod.check = (o) => {
		o.value.startsWith(n.prefix) || o.issues.push({
			origin: "string",
			code: "invalid_format",
			format: "starts_with",
			prefix: n.prefix,
			input: o.value,
			inst: e,
			continue: !n.abort
		});
	};
}), Na = d("$ZodCheckEndsWith", (e, n) => {
	D.init(e, n);
	const i = new RegExp(`.*${H(n.suffix)}$`);
	n.pattern ?? (n.pattern = i), e._zod.onattach.push((o) => {
		const t = o._zod.bag;
		t.patterns ?? (t.patterns = /* @__PURE__ */ new Set()), t.patterns.add(i);
	}), e._zod.check = (o) => {
		o.value.endsWith(n.suffix) || o.issues.push({
			origin: "string",
			code: "invalid_format",
			format: "ends_with",
			suffix: n.suffix,
			input: o.value,
			inst: e,
			continue: !n.abort
		});
	};
});
function Ti(e, n, i) {
	e.issues.length && n.issues.push(...J(i, e.issues));
}
const Pa = d("$ZodCheckProperty", (e, n) => {
	D.init(e, n), e._zod.check = (i) => {
		const o = n.schema._zod.run({
			value: i.value[n.property],
			issues: []
		}, {});
		if (o instanceof Promise) return o.then((t) => Ti(t, i, n.property));
		Ti(o, i, n.property);
	};
}), Ta = d("$ZodCheckMimeType", (e, n) => {
	D.init(e, n);
	const i = new Set(n.mime);
	e._zod.onattach.push((o) => {
		o._zod.bag.mime = n.mime;
	}), e._zod.check = (o) => {
		i.has(o.value.type) || o.issues.push({
			code: "invalid_value",
			values: n.mime,
			input: o.value.type,
			inst: e,
			continue: !n.abort
		});
	};
}), Ea = d("$ZodCheckOverwrite", (e, n) => {
	D.init(e, n), e._zod.check = (i) => {
		i.value = n.tx(i.value);
	};
});
var Aa = class {
	constructor(e = []) {
		this.content = [], this.indent = 0, this && (this.args = e);
	}
	indented(e) {
		this.indent += 1, e(this), this.indent -= 1;
	}
	write(e) {
		if (typeof e == "function") {
			e(this, { execution: "sync" }), e(this, { execution: "async" });
			return;
		}
		const n = e.split(`
`).filter((t) => t), i = Math.min(...n.map((t) => t.length - t.trimStart().length)), o = n.map((t) => t.slice(i)).map((t) => " ".repeat(this.indent * 2) + t);
		for (const t of o) this.content.push(t);
	}
	compile() {
		const e = Function, n = this?.args, i = [...(this?.content ?? [""]).map((o) => `  ${o}`)];
		return new e(...n, i.join(`
`));
	}
};
const Ca = {
	major: 4,
	minor: 4,
	patch: 3
}, y = d("$ZodType", (e, n) => {
	var i;
	e ?? (e = {}), e._zod.def = n, e._zod.bag = e._zod.bag || {}, e._zod.version = Ca;
	const o = [...e._zod.def.checks ?? []];
	e._zod.traits.has("$ZodCheck") && o.unshift(e);
	for (const t of o) for (const r of t._zod.onattach) r(e);
	if (o.length === 0) (i = e._zod).deferred ?? (i.deferred = []), e._zod.deferred?.push(() => {
		e._zod.run = e._zod.parse;
	});
	else {
		const t = (a, u, l) => {
			let c = se(a), s;
			for (const f of u) {
				if (f._zod.def.when) {
					if (Uo(a) || !f._zod.def.when(a)) continue;
				} else if (c) continue;
				const m = a.issues.length, g = f._zod.check(a);
				if (g instanceof Promise && l?.async === !1) throw new de();
				if (s || g instanceof Promise) s = (s ?? Promise.resolve()).then(async () => {
					await g, a.issues.length !== m && (c || (c = se(a, m)));
				});
				else {
					if (a.issues.length === m) continue;
					c || (c = se(a, m));
				}
			}
			return s ? s.then(() => a) : a;
		}, r = (a, u, l) => {
			if (se(a)) return a.aborted = !0, a;
			const c = t(u, o, l);
			if (c instanceof Promise) {
				if (l.async === !1) throw new de();
				return c.then((s) => e._zod.parse(s, l));
			}
			return e._zod.parse(c, l);
		};
		e._zod.run = (a, u) => {
			if (u.skipChecks) return e._zod.parse(a, u);
			if (u.direction === "backward") {
				const c = e._zod.parse({
					value: a.value,
					issues: []
				}, {
					...u,
					skipChecks: !0
				});
				return c instanceof Promise ? c.then((s) => r(s, a, u)) : r(c, a, u);
			}
			const l = e._zod.parse(a, u);
			if (l instanceof Promise) {
				if (u.async === !1) throw new de();
				return l.then((c) => t(c, o, u));
			}
			return t(l, o, u);
		};
	}
	S(e, "~standard", () => ({
		validate: (t) => {
			try {
				const r = Eo(e, t);
				return r.success ? { value: r.data } : { issues: r.error?.issues };
			} catch {
				return Ao(e, t).then((a) => a.success ? { value: a.data } : { issues: a.error?.issues });
			}
		},
		vendor: "zod",
		version: 1
	}));
}), Ye = d("$ZodString", (e, n) => {
	y.init(e, n), e._zod.pattern = [...e?._zod.bag?.patterns ?? []].pop() ?? la(e._zod.bag), e._zod.parse = (i, o) => {
		if (n.coerce) try {
			i.value = String(i.value);
		} catch {}
		return typeof i.value == "string" || i.issues.push({
			expected: "string",
			code: "invalid_type",
			input: i.value,
			inst: e
		}), i;
	};
}), x = d("$ZodStringFormat", (e, n) => {
	qe.init(e, n), Ye.init(e, n);
}), Ra = d("$ZodGUID", (e, n) => {
	n.pattern ?? (n.pattern = Go), x.init(e, n);
}), La = d("$ZodUUID", (e, n) => {
	if (n.version) {
		const i = {
			v1: 1,
			v2: 2,
			v3: 3,
			v4: 4,
			v5: 5,
			v6: 6,
			v7: 7,
			v8: 8
		}[n.version];
		if (i === void 0) throw new Error(`Invalid UUID version: "${n.version}"`);
		n.pattern ?? (n.pattern = Se(i));
	} else n.pattern ?? (n.pattern = Se());
	x.init(e, n);
}), Fa = d("$ZodEmail", (e, n) => {
	n.pattern ?? (n.pattern = Vo), x.init(e, n);
}), Ja = d("$ZodURL", (e, n) => {
	x.init(e, n), e._zod.check = (i) => {
		try {
			const o = i.value.trim();
			if (!n.normalize && n.protocol?.source === Xn.source && !/^https?:\/\//i.test(o)) {
				i.issues.push({
					code: "invalid_format",
					format: "url",
					note: "Invalid URL format",
					input: i.value,
					inst: e,
					continue: !n.abort
				});
				return;
			}
			const t = new URL(o);
			n.hostname && (n.hostname.lastIndex = 0, n.hostname.test(t.hostname) || i.issues.push({
				code: "invalid_format",
				format: "url",
				note: "Invalid hostname",
				pattern: n.hostname.source,
				input: i.value,
				inst: e,
				continue: !n.abort
			})), n.protocol && (n.protocol.lastIndex = 0, n.protocol.test(t.protocol.endsWith(":") ? t.protocol.slice(0, -1) : t.protocol) || i.issues.push({
				code: "invalid_format",
				format: "url",
				note: "Invalid protocol",
				pattern: n.protocol.source,
				input: i.value,
				inst: e,
				continue: !n.abort
			})), n.normalize ? i.value = t.href : i.value = o;
			return;
		} catch {
			i.issues.push({
				code: "invalid_format",
				format: "url",
				input: i.value,
				inst: e,
				continue: !n.abort
			});
		}
	};
}), Ma = d("$ZodEmoji", (e, n) => {
	n.pattern ?? (n.pattern = Wo()), x.init(e, n);
}), Ka = d("$ZodNanoID", (e, n) => {
	n.pattern ?? (n.pattern = Mo), x.init(e, n);
}), Ga = d("$ZodCUID", (e, n) => {
	n.pattern ?? (n.pattern = Co), x.init(e, n);
}), Va = d("$ZodCUID2", (e, n) => {
	n.pattern ?? (n.pattern = Ro), x.init(e, n);
}), Ba = d("$ZodULID", (e, n) => {
	n.pattern ?? (n.pattern = Lo), x.init(e, n);
}), Wa = d("$ZodXID", (e, n) => {
	n.pattern ?? (n.pattern = Fo), x.init(e, n);
}), Xa = d("$ZodKSUID", (e, n) => {
	n.pattern ?? (n.pattern = Jo), x.init(e, n);
}), qa = d("$ZodISODateTime", (e, n) => {
	n.pattern ?? (n.pattern = ca(n)), x.init(e, n);
}), Ya = d("$ZodISODate", (e, n) => {
	n.pattern ?? (n.pattern = oa), x.init(e, n);
}), Ha = d("$ZodISOTime", (e, n) => {
	n.pattern ?? (n.pattern = ua(n)), x.init(e, n);
}), Qa = d("$ZodISODuration", (e, n) => {
	n.pattern ?? (n.pattern = Ko), x.init(e, n);
}), eu = d("$ZodIPv4", (e, n) => {
	n.pattern ?? (n.pattern = Xo), x.init(e, n), e._zod.bag.format = "ipv4";
}), tu = d("$ZodIPv6", (e, n) => {
	n.pattern ?? (n.pattern = qo), x.init(e, n), e._zod.bag.format = "ipv6", e._zod.check = (i) => {
		try {
			new URL(`http://[${i.value}]`);
		} catch {
			i.issues.push({
				code: "invalid_format",
				format: "ipv6",
				input: i.value,
				inst: e,
				continue: !n.abort
			});
		}
	};
}), nu = d("$ZodMAC", (e, n) => {
	n.pattern ?? (n.pattern = Yo(n.delimiter)), x.init(e, n), e._zod.bag.format = "mac";
}), ru = d("$ZodCIDRv4", (e, n) => {
	n.pattern ?? (n.pattern = Ho), x.init(e, n);
}), iu = d("$ZodCIDRv6", (e, n) => {
	n.pattern ?? (n.pattern = Qo), x.init(e, n), e._zod.check = (i) => {
		const o = i.value.split("/");
		try {
			if (o.length !== 2) throw new Error();
			const [t, r] = o;
			if (!r) throw new Error();
			const a = Number(r);
			if (`${a}` !== r) throw new Error();
			if (a < 0 || a > 128) throw new Error();
			new URL(`http://[${t}]`);
		} catch {
			i.issues.push({
				code: "invalid_format",
				format: "cidrv6",
				input: i.value,
				inst: e,
				continue: !n.abort
			});
		}
	};
});
function Qn(e) {
	if (e === "") return !0;
	if (/\s/.test(e) || e.length % 4 !== 0) return !1;
	try {
		return atob(e), !0;
	} catch {
		return !1;
	}
}
const ou = d("$ZodBase64", (e, n) => {
	n.pattern ?? (n.pattern = ea), x.init(e, n), e._zod.bag.contentEncoding = "base64", e._zod.check = (i) => {
		Qn(i.value) || i.issues.push({
			code: "invalid_format",
			format: "base64",
			input: i.value,
			inst: e,
			continue: !n.abort
		});
	};
});
function au(e) {
	if (!Wn.test(e)) return !1;
	const n = e.replace(/[-_]/g, (i) => i === "-" ? "+" : "/");
	return Qn(n.padEnd(Math.ceil(n.length / 4) * 4, "="));
}
const uu = d("$ZodBase64URL", (e, n) => {
	n.pattern ?? (n.pattern = Wn), x.init(e, n), e._zod.bag.contentEncoding = "base64url", e._zod.check = (i) => {
		au(i.value) || i.issues.push({
			code: "invalid_format",
			format: "base64url",
			input: i.value,
			inst: e,
			continue: !n.abort
		});
	};
}), cu = d("$ZodE164", (e, n) => {
	n.pattern ?? (n.pattern = ra), x.init(e, n);
});
function lu(e, n = null) {
	try {
		const i = e.split(".");
		if (i.length !== 3) return !1;
		const [o] = i;
		if (!o) return !1;
		const t = JSON.parse(atob(o));
		return !("typ" in t && t?.typ !== "JWT" || !t.alg || n && (!("alg" in t) || t.alg !== n));
	} catch {
		return !1;
	}
}
const su = d("$ZodJWT", (e, n) => {
	x.init(e, n), e._zod.check = (i) => {
		lu(i.value, n.alg) || i.issues.push({
			code: "invalid_format",
			format: "jwt",
			input: i.value,
			inst: e,
			continue: !n.abort
		});
	};
}), du = d("$ZodCustomStringFormat", (e, n) => {
	x.init(e, n), e._zod.check = (i) => {
		n.fn(i.value) || i.issues.push({
			code: "invalid_format",
			format: n.format,
			input: i.value,
			inst: e,
			continue: !n.abort
		});
	};
}), er = d("$ZodNumber", (e, n) => {
	y.init(e, n), e._zod.pattern = e._zod.bag.pattern ?? qn, e._zod.parse = (i, o) => {
		if (n.coerce) try {
			i.value = Number(i.value);
		} catch {}
		const t = i.value;
		if (typeof t == "number" && !Number.isNaN(t) && Number.isFinite(t)) return i;
		const r = typeof t == "number" ? Number.isNaN(t) ? "NaN" : Number.isFinite(t) ? void 0 : "Infinity" : void 0;
		return i.issues.push({
			expected: "number",
			code: "invalid_type",
			input: t,
			inst: e,
			...r ? { received: r } : {}
		}), i;
	};
}), mu = d("$ZodNumberFormat", (e, n) => {
	ba.init(e, n), er.init(e, n);
}), tr = d("$ZodBoolean", (e, n) => {
	y.init(e, n), e._zod.pattern = ma, e._zod.parse = (i, o) => {
		if (n.coerce) try {
			i.value = !!i.value;
		} catch {}
		const t = i.value;
		return typeof t == "boolean" || i.issues.push({
			expected: "boolean",
			code: "invalid_type",
			input: t,
			inst: e
		}), i;
	};
}), nr = d("$ZodBigInt", (e, n) => {
	y.init(e, n), e._zod.pattern = sa, e._zod.parse = (i, o) => {
		if (n.coerce) try {
			i.value = BigInt(i.value);
		} catch {}
		return typeof i.value == "bigint" || i.issues.push({
			expected: "bigint",
			code: "invalid_type",
			input: i.value,
			inst: e
		}), i;
	};
}), fu = d("$ZodBigIntFormat", (e, n) => {
	ya.init(e, n), nr.init(e, n);
}), pu = d("$ZodSymbol", (e, n) => {
	y.init(e, n), e._zod.parse = (i, o) => {
		const t = i.value;
		return typeof t == "symbol" || i.issues.push({
			expected: "symbol",
			code: "invalid_type",
			input: t,
			inst: e
		}), i;
	};
}), vu = d("$ZodUndefined", (e, n) => {
	y.init(e, n), e._zod.pattern = pa, e._zod.values = new Set([void 0]), e._zod.parse = (i, o) => {
		const t = i.value;
		return typeof t > "u" || i.issues.push({
			expected: "undefined",
			code: "invalid_type",
			input: t,
			inst: e
		}), i;
	};
}), gu = d("$ZodNull", (e, n) => {
	y.init(e, n), e._zod.pattern = fa, e._zod.values = new Set([null]), e._zod.parse = (i, o) => {
		const t = i.value;
		return t === null || i.issues.push({
			expected: "null",
			code: "invalid_type",
			input: t,
			inst: e
		}), i;
	};
}), hu = d("$ZodAny", (e, n) => {
	y.init(e, n), e._zod.parse = (i) => i;
}), $u = d("$ZodUnknown", (e, n) => {
	y.init(e, n), e._zod.parse = (i) => i;
}), _u = d("$ZodNever", (e, n) => {
	y.init(e, n), e._zod.parse = (i, o) => (i.issues.push({
		expected: "never",
		code: "invalid_type",
		input: i.value,
		inst: e
	}), i);
}), bu = d("$ZodVoid", (e, n) => {
	y.init(e, n), e._zod.parse = (i, o) => {
		const t = i.value;
		return typeof t > "u" || i.issues.push({
			expected: "void",
			code: "invalid_type",
			input: t,
			inst: e
		}), i;
	};
}), yu = d("$ZodDate", (e, n) => {
	y.init(e, n), e._zod.parse = (i, o) => {
		if (n.coerce) try {
			i.value = new Date(i.value);
		} catch {}
		const t = i.value, r = t instanceof Date;
		return r && !Number.isNaN(t.getTime()) || i.issues.push({
			expected: "date",
			code: "invalid_type",
			input: t,
			...r ? { received: "Invalid Date" } : {},
			inst: e
		}), i;
	};
});
function Ei(e, n, i) {
	e.issues.length && n.issues.push(...J(i, e.issues)), n.value[i] = e.value;
}
const ku = d("$ZodArray", (e, n) => {
	y.init(e, n), e._zod.parse = (i, o) => {
		const t = i.value;
		if (!Array.isArray(t)) return i.issues.push({
			expected: "array",
			code: "invalid_type",
			input: t,
			inst: e
		}), i;
		i.value = Array(t.length);
		const r = [];
		for (let a = 0; a < t.length; a++) {
			const u = t[a], l = n.element._zod.run({
				value: u,
				issues: []
			}, o);
			l instanceof Promise ? r.push(l.then((c) => Ei(c, i, a))) : Ei(l, i, a);
		}
		return r.length ? Promise.all(r).then(() => i) : i;
	};
});
function kt(e, n, i, o, t, r) {
	const a = i in o;
	if (e.issues.length) {
		if (t && r && !a) return;
		n.issues.push(...J(i, e.issues));
	}
	if (!a && !t) {
		e.issues.length || n.issues.push({
			code: "invalid_type",
			expected: "nonoptional",
			input: void 0,
			path: [i]
		});
		return;
	}
	e.value === void 0 ? a && (n.value[i] = void 0) : n.value[i] = e.value;
}
function Su(e) {
	const n = Object.keys(e.shape);
	for (const o of n) if (!e.shape?.[o]?._zod?.traits?.has("$ZodType")) throw new Error(`Invalid element at key "${o}": expected a Zod schema`);
	const i = _o(e.shape);
	return {
		...e,
		keys: n,
		keySet: new Set(n),
		numKeys: n.length,
		optionalKeys: new Set(i)
	};
}
function Iu(e, n, i, o, t, r) {
	const a = [], u = t.keySet, l = t.catchall._zod, c = l.def.type, s = l.optin === "optional", f = l.optout === "optional";
	for (const m in n) {
		if (m === "__proto__" || u.has(m)) continue;
		if (c === "never") {
			a.push(m);
			continue;
		}
		const g = l.run({
			value: n[m],
			issues: []
		}, o);
		g instanceof Promise ? e.push(g.then((I) => kt(I, i, m, n, s, f))) : kt(g, i, m, n, s, f);
	}
	return a.length && i.issues.push({
		code: "unrecognized_keys",
		keys: a,
		input: n,
		inst: r
	}), e.length ? Promise.all(e).then(() => i) : i;
}
const zu = d("$ZodObject", (e, n) => {
	if (y.init(e, n), !Object.getOwnPropertyDescriptor(n, "shape")?.get) {
		const a = n.shape;
		Object.defineProperty(n, "shape", { get: () => {
			const u = { ...a };
			return Object.defineProperty(n, "shape", { value: u }), u;
		} });
	}
	const i = Me(() => Su(n));
	S(e._zod, "propValues", () => {
		const a = n.shape, u = {};
		for (const l in a) {
			const c = a[l]._zod;
			if (c.values) {
				u[l] ?? (u[l] = /* @__PURE__ */ new Set());
				for (const s of c.values) u[l].add(s);
			}
		}
		return u;
	});
	const o = ye, t = n.catchall;
	let r;
	e._zod.parse = (a, u) => {
		r ?? (r = i.value);
		const l = a.value;
		if (!o(l)) return a.issues.push({
			expected: "object",
			code: "invalid_type",
			input: l,
			inst: e
		}), a;
		a.value = {};
		const c = [], s = r.shape;
		for (const f of r.keys) {
			const m = s[f], g = m._zod.optin === "optional", I = m._zod.optout === "optional", U = m._zod.run({
				value: l[f],
				issues: []
			}, u);
			U instanceof Promise ? c.push(U.then((N) => kt(N, a, f, l, g, I))) : kt(U, a, f, l, g, I);
		}
		return t ? Iu(c, l, a, u, i.value, e) : c.length ? Promise.all(c).then(() => a) : a;
	};
}), wu = d("$ZodObjectJIT", (e, n) => {
	zu.init(e, n);
	const i = e._zod.parse, o = Me(() => Su(n)), t = (m) => {
		const g = new Aa([
			"shape",
			"payload",
			"ctx"
		]), I = o.value, U = (O) => {
			const z = In(O);
			return `shape[${z}]._zod.run({ value: input[${z}], issues: [] }, ctx)`;
		};
		g.write("const input = payload.value;");
		const N = Object.create(null);
		let A = 0;
		for (const O of I.keys) N[O] = `key_${A++}`;
		g.write("const newResult = {};");
		for (const O of I.keys) {
			const z = N[O], j = In(O), V = m[O], le = V?._zod?.optin === "optional", q = V?._zod?.optout === "optional";
			g.write(`const ${z} = ${U(O)};`), le && q ? g.write(`
        if (${z}.issues.length) {
          if (${j} in input) {
            payload.issues = payload.issues.concat(${z}.issues.map(iss => ({
              ...iss,
              path: iss.path ? [${j}, ...iss.path] : [${j}]
            })));
          }
        }
        
        if (${z}.value === undefined) {
          if (${j} in input) {
            newResult[${j}] = undefined;
          }
        } else {
          newResult[${j}] = ${z}.value;
        }
        
      `) : le ? g.write(`
        if (${z}.issues.length) {
          payload.issues = payload.issues.concat(${z}.issues.map(iss => ({
            ...iss,
            path: iss.path ? [${j}, ...iss.path] : [${j}]
          })));
        }
        
        if (${z}.value === undefined) {
          if (${j} in input) {
            newResult[${j}] = undefined;
          }
        } else {
          newResult[${j}] = ${z}.value;
        }
        
      `) : g.write(`
        const ${z}_present = ${j} in input;
        if (${z}.issues.length) {
          payload.issues = payload.issues.concat(${z}.issues.map(iss => ({
            ...iss,
            path: iss.path ? [${j}, ...iss.path] : [${j}]
          })));
        }
        if (!${z}_present && !${z}.issues.length) {
          payload.issues.push({
            code: "invalid_type",
            expected: "nonoptional",
            input: undefined,
            path: [${j}]
          });
        }

        if (${z}_present) {
          if (${z}.value === undefined) {
            newResult[${j}] = undefined;
          } else {
            newResult[${j}] = ${z}.value;
          }
        }

      `);
		}
		g.write("payload.value = newResult;"), g.write("return payload;");
		const ce = g.compile();
		return (O, z) => ce(m, O, z);
	};
	let r;
	const a = ye, u = !Ee.jitless, c = u && ho.value, s = n.catchall;
	let f;
	e._zod.parse = (m, g) => {
		f ?? (f = o.value);
		const I = m.value;
		return a(I) ? u && c && g?.async === !1 && g.jitless !== !0 ? (r || (r = t(n.shape)), m = r(m, g), s ? Iu([], I, m, g, f, e) : m) : i(m, g) : (m.issues.push({
			expected: "object",
			code: "invalid_type",
			input: I,
			inst: e
		}), m);
	};
});
function Ai(e, n, i, o) {
	for (const r of e) if (r.issues.length === 0) return n.value = r.value, n;
	const t = e.filter((r) => !se(r));
	return t.length === 1 ? (n.value = t[0].value, t[0]) : (n.issues.push({
		code: "invalid_union",
		input: n.value,
		inst: i,
		errors: e.map((r) => r.issues.map((a) => R(a, o, P())))
	}), n);
}
const Nt = d("$ZodUnion", (e, n) => {
	y.init(e, n), S(e._zod, "optin", () => n.options.some((o) => o._zod.optin === "optional") ? "optional" : void 0), S(e._zod, "optout", () => n.options.some((o) => o._zod.optout === "optional") ? "optional" : void 0), S(e._zod, "values", () => {
		if (n.options.every((o) => o._zod.values)) return new Set(n.options.flatMap((o) => Array.from(o._zod.values)));
	}), S(e._zod, "pattern", () => {
		if (n.options.every((o) => o._zod.pattern)) {
			const o = n.options.map((t) => t._zod.pattern);
			return new RegExp(`^(${o.map((t) => Ut(t.source)).join("|")})$`);
		}
	});
	const i = n.options.length === 1 ? n.options[0]._zod.run : null;
	e._zod.parse = (o, t) => {
		if (i) return i(o, t);
		let r = !1;
		const a = [];
		for (const u of n.options) {
			const l = u._zod.run({
				value: o.value,
				issues: []
			}, t);
			if (l instanceof Promise) a.push(l), r = !0;
			else {
				if (l.issues.length === 0) return l;
				a.push(l);
			}
		}
		return r ? Promise.all(a).then((u) => Ai(u, o, e, t)) : Ai(a, o, e, t);
	};
});
function Ci(e, n, i, o) {
	const t = e.filter((r) => r.issues.length === 0);
	return t.length === 1 ? (n.value = t[0].value, n) : (t.length === 0 ? n.issues.push({
		code: "invalid_union",
		input: n.value,
		inst: i,
		errors: e.map((r) => r.issues.map((a) => R(a, o, P())))
	}) : n.issues.push({
		code: "invalid_union",
		input: n.value,
		inst: i,
		errors: [],
		inclusive: !1
	}), n);
}
const xu = d("$ZodXor", (e, n) => {
	Nt.init(e, n), n.inclusive = !1;
	const i = n.options.length === 1 ? n.options[0]._zod.run : null;
	e._zod.parse = (o, t) => {
		if (i) return i(o, t);
		let r = !1;
		const a = [];
		for (const u of n.options) {
			const l = u._zod.run({
				value: o.value,
				issues: []
			}, t);
			l instanceof Promise ? (a.push(l), r = !0) : a.push(l);
		}
		return r ? Promise.all(a).then((u) => Ci(u, o, e, t)) : Ci(a, o, e, t);
	};
}), Zu = d("$ZodDiscriminatedUnion", (e, n) => {
	n.inclusive = !1, Nt.init(e, n);
	const i = e._zod.parse;
	S(e._zod, "propValues", () => {
		const t = {};
		for (const r of n.options) {
			const a = r._zod.propValues;
			if (!a || Object.keys(a).length === 0) throw new Error(`Invalid discriminated union option at index "${n.options.indexOf(r)}"`);
			for (const [u, l] of Object.entries(a)) {
				t[u] || (t[u] = /* @__PURE__ */ new Set());
				for (const c of l) t[u].add(c);
			}
		}
		return t;
	});
	const o = Me(() => {
		const t = n.options, r = /* @__PURE__ */ new Map();
		for (const a of t) {
			const u = a._zod.propValues?.[n.discriminator];
			if (!u || u.size === 0) throw new Error(`Invalid discriminated union option at index "${n.options.indexOf(a)}"`);
			for (const l of u) {
				if (r.has(l)) throw new Error(`Duplicate discriminator value "${String(l)}"`);
				r.set(l, a);
			}
		}
		return r;
	});
	e._zod.parse = (t, r) => {
		const a = t.value;
		if (!ye(a)) return t.issues.push({
			code: "invalid_type",
			expected: "object",
			input: a,
			inst: e
		}), t;
		const u = o.value.get(a?.[n.discriminator]);
		return u ? u._zod.run(t, r) : n.unionFallback || r.direction === "backward" ? i(t, r) : (t.issues.push({
			code: "invalid_union",
			errors: [],
			note: "No matching discriminator",
			discriminator: n.discriminator,
			options: Array.from(o.value.keys()),
			input: a,
			path: [n.discriminator],
			inst: e
		}), t);
	};
}), Uu = d("$ZodIntersection", (e, n) => {
	y.init(e, n), e._zod.parse = (i, o) => {
		const t = i.value, r = n.left._zod.run({
			value: t,
			issues: []
		}, o), a = n.right._zod.run({
			value: t,
			issues: []
		}, o);
		return r instanceof Promise || a instanceof Promise ? Promise.all([r, a]).then(([u, l]) => Ri(i, u, l)) : Ri(i, r, a);
	};
});
function xn(e, n) {
	if (e === n) return {
		valid: !0,
		data: e
	};
	if (e instanceof Date && n instanceof Date && +e == +n) return {
		valid: !0,
		data: e
	};
	if (me(e) && me(n)) {
		const i = Object.keys(n), o = Object.keys(e).filter((r) => i.indexOf(r) !== -1), t = {
			...e,
			...n
		};
		for (const r of o) {
			const a = xn(e[r], n[r]);
			if (!a.valid) return {
				valid: !1,
				mergeErrorPath: [r, ...a.mergeErrorPath]
			};
			t[r] = a.data;
		}
		return {
			valid: !0,
			data: t
		};
	}
	if (Array.isArray(e) && Array.isArray(n)) {
		if (e.length !== n.length) return {
			valid: !1,
			mergeErrorPath: []
		};
		const i = [];
		for (let o = 0; o < e.length; o++) {
			const t = e[o], r = n[o], a = xn(t, r);
			if (!a.valid) return {
				valid: !1,
				mergeErrorPath: [o, ...a.mergeErrorPath]
			};
			i.push(a.data);
		}
		return {
			valid: !0,
			data: i
		};
	}
	return {
		valid: !1,
		mergeErrorPath: []
	};
}
function Ri(e, n, i) {
	const o = /* @__PURE__ */ new Map();
	let t;
	for (const u of n.issues) if (u.code === "unrecognized_keys") {
		t ?? (t = u);
		for (const l of u.keys) o.has(l) || o.set(l, {}), o.get(l).l = !0;
	} else e.issues.push(u);
	for (const u of i.issues) if (u.code === "unrecognized_keys") for (const l of u.keys) o.has(l) || o.set(l, {}), o.get(l).r = !0;
	else e.issues.push(u);
	const r = [...o].filter(([, u]) => u.l && u.r).map(([u]) => u);
	if (r.length && t && e.issues.push({
		...t,
		keys: r
	}), se(e)) return e;
	const a = xn(n.value, i.value);
	if (!a.valid) throw new Error(`Unmergable intersection. Error path: ${JSON.stringify(a.mergeErrorPath)}`);
	return e.value = a.data, e;
}
const rr = d("$ZodTuple", (e, n) => {
	y.init(e, n);
	const i = n.items;
	e._zod.parse = (o, t) => {
		const r = o.value;
		if (!Array.isArray(r)) return o.issues.push({
			input: r,
			inst: e,
			expected: "tuple",
			code: "invalid_type"
		}), o;
		o.value = [];
		const a = [], u = Li(i, "optin"), l = Li(i, "optout");
		if (!n.rest) {
			if (r.length < u) return o.issues.push({
				code: "too_small",
				minimum: u,
				inclusive: !0,
				input: r,
				inst: e,
				origin: "array"
			}), o;
			r.length > i.length && o.issues.push({
				code: "too_big",
				maximum: i.length,
				inclusive: !0,
				input: r,
				inst: e,
				origin: "array"
			});
		}
		const c = new Array(i.length);
		for (let s = 0; s < i.length; s++) {
			const f = i[s]._zod.run({
				value: r[s],
				issues: []
			}, t);
			f instanceof Promise ? a.push(f.then((m) => {
				c[s] = m;
			})) : c[s] = f;
		}
		if (n.rest) {
			let s = i.length - 1;
			const f = r.slice(i.length);
			for (const m of f) {
				s++;
				const g = n.rest._zod.run({
					value: m,
					issues: []
				}, t);
				g instanceof Promise ? a.push(g.then((I) => Fi(I, o, s))) : Fi(g, o, s);
			}
		}
		return a.length ? Promise.all(a).then(() => Ji(c, o, i, r, l)) : Ji(c, o, i, r, l);
	};
});
function Li(e, n) {
	for (let i = e.length - 1; i >= 0; i--) if (e[i]._zod[n] !== "optional") return i + 1;
	return 0;
}
function Fi(e, n, i) {
	e.issues.length && n.issues.push(...J(i, e.issues)), n.value[i] = e.value;
}
function Ji(e, n, i, o, t) {
	for (let r = 0; r < i.length; r++) {
		const a = e[r], u = r < o.length;
		if (a.issues.length) {
			if (!u && r >= t) {
				n.value.length = r;
				break;
			}
			n.issues.push(...J(r, a.issues));
		}
		n.value[r] = a.value;
	}
	for (let r = n.value.length - 1; r >= o.length && i[r]._zod.optout === "optional" && n.value[r] === void 0; r--) n.value.length = r;
	return n;
}
const ju = d("$ZodRecord", (e, n) => {
	y.init(e, n), e._zod.parse = (i, o) => {
		const t = i.value;
		if (!me(t)) return i.issues.push({
			expected: "record",
			code: "invalid_type",
			input: t,
			inst: e
		}), i;
		const r = [], a = n.keyType._zod.values;
		if (a) {
			i.value = {};
			const u = /* @__PURE__ */ new Set();
			for (const c of a) if (typeof c == "string" || typeof c == "number" || typeof c == "symbol") {
				u.add(typeof c == "number" ? c.toString() : c);
				const s = n.keyType._zod.run({
					value: c,
					issues: []
				}, o);
				if (s instanceof Promise) throw new Error("Async schemas not supported in object keys currently");
				if (s.issues.length) {
					i.issues.push({
						code: "invalid_key",
						origin: "record",
						issues: s.issues.map((g) => R(g, o, P())),
						input: c,
						path: [c],
						inst: e
					});
					continue;
				}
				const f = s.value, m = n.valueType._zod.run({
					value: t[c],
					issues: []
				}, o);
				m instanceof Promise ? r.push(m.then((g) => {
					g.issues.length && i.issues.push(...J(c, g.issues)), i.value[f] = g.value;
				})) : (m.issues.length && i.issues.push(...J(c, m.issues)), i.value[f] = m.value);
			}
			let l;
			for (const c in t) u.has(c) || (l = l ?? [], l.push(c));
			l && l.length > 0 && i.issues.push({
				code: "unrecognized_keys",
				input: t,
				inst: e,
				keys: l
			});
		} else {
			i.value = {};
			for (const u of Reflect.ownKeys(t)) {
				if (u === "__proto__" || !Object.prototype.propertyIsEnumerable.call(t, u)) continue;
				let l = n.keyType._zod.run({
					value: u,
					issues: []
				}, o);
				if (l instanceof Promise) throw new Error("Async schemas not supported in object keys currently");
				if (typeof u == "string" && qn.test(u) && l.issues.length) {
					const s = n.keyType._zod.run({
						value: Number(u),
						issues: []
					}, o);
					if (s instanceof Promise) throw new Error("Async schemas not supported in object keys currently");
					s.issues.length === 0 && (l = s);
				}
				if (l.issues.length) {
					n.mode === "loose" ? i.value[u] = t[u] : i.issues.push({
						code: "invalid_key",
						origin: "record",
						issues: l.issues.map((s) => R(s, o, P())),
						input: u,
						path: [u],
						inst: e
					});
					continue;
				}
				const c = n.valueType._zod.run({
					value: t[u],
					issues: []
				}, o);
				c instanceof Promise ? r.push(c.then((s) => {
					s.issues.length && i.issues.push(...J(u, s.issues)), i.value[l.value] = s.value;
				})) : (c.issues.length && i.issues.push(...J(u, c.issues)), i.value[l.value] = c.value);
			}
		}
		return r.length ? Promise.all(r).then(() => i) : i;
	};
}), Du = d("$ZodMap", (e, n) => {
	y.init(e, n), e._zod.parse = (i, o) => {
		const t = i.value;
		if (!(t instanceof Map)) return i.issues.push({
			expected: "map",
			code: "invalid_type",
			input: t,
			inst: e
		}), i;
		const r = [];
		i.value = /* @__PURE__ */ new Map();
		for (const [a, u] of t) {
			const l = n.keyType._zod.run({
				value: a,
				issues: []
			}, o), c = n.valueType._zod.run({
				value: u,
				issues: []
			}, o);
			l instanceof Promise || c instanceof Promise ? r.push(Promise.all([l, c]).then(([s, f]) => {
				Mi(s, f, i, a, t, e, o);
			})) : Mi(l, c, i, a, t, e, o);
		}
		return r.length ? Promise.all(r).then(() => i) : i;
	};
});
function Mi(e, n, i, o, t, r, a) {
	e.issues.length && (yt.has(typeof o) ? i.issues.push(...J(o, e.issues)) : i.issues.push({
		code: "invalid_key",
		origin: "map",
		input: t,
		inst: r,
		issues: e.issues.map((u) => R(u, a, P()))
	})), n.issues.length && (yt.has(typeof o) ? i.issues.push(...J(o, n.issues)) : i.issues.push({
		origin: "map",
		code: "invalid_element",
		input: t,
		inst: r,
		key: o,
		issues: n.issues.map((u) => R(u, a, P()))
	})), i.value.set(e.value, n.value);
}
const Ou = d("$ZodSet", (e, n) => {
	y.init(e, n), e._zod.parse = (i, o) => {
		const t = i.value;
		if (!(t instanceof Set)) return i.issues.push({
			input: t,
			inst: e,
			expected: "set",
			code: "invalid_type"
		}), i;
		const r = [];
		i.value = /* @__PURE__ */ new Set();
		for (const a of t) {
			const u = n.valueType._zod.run({
				value: a,
				issues: []
			}, o);
			u instanceof Promise ? r.push(u.then((l) => Ki(l, i))) : Ki(u, i);
		}
		return r.length ? Promise.all(r).then(() => i) : i;
	};
});
function Ki(e, n) {
	e.issues.length && n.issues.push(...e.issues), n.value.add(e.value);
}
const Nu = d("$ZodEnum", (e, n) => {
	y.init(e, n);
	const i = Pn(n.entries), o = new Set(i);
	e._zod.values = o, e._zod.pattern = new RegExp(`^(${i.filter((t) => yt.has(typeof t)).map((t) => typeof t == "string" ? H(t) : t.toString()).join("|")})$`), e._zod.parse = (t, r) => {
		const a = t.value;
		return o.has(a) || t.issues.push({
			code: "invalid_value",
			values: i,
			input: a,
			inst: e
		}), t;
	};
}), Pu = d("$ZodLiteral", (e, n) => {
	if (y.init(e, n), n.values.length === 0) throw new Error("Cannot create literal schema with no valid values");
	const i = new Set(n.values);
	e._zod.values = i, e._zod.pattern = new RegExp(`^(${n.values.map((o) => typeof o == "string" ? H(o) : o ? H(o.toString()) : String(o)).join("|")})$`), e._zod.parse = (o, t) => {
		const r = o.value;
		return i.has(r) || o.issues.push({
			code: "invalid_value",
			values: n.values,
			input: r,
			inst: e
		}), o;
	};
}), Tu = d("$ZodFile", (e, n) => {
	y.init(e, n), e._zod.parse = (i, o) => {
		const t = i.value;
		return t instanceof File || i.issues.push({
			expected: "file",
			code: "invalid_type",
			input: t,
			inst: e
		}), i;
	};
}), Eu = d("$ZodTransform", (e, n) => {
	y.init(e, n), e._zod.optin = "optional", e._zod.parse = (i, o) => {
		if (o.direction === "backward") throw new Zt(e.constructor.name);
		const t = n.transform(i.value, i);
		if (o.async) return (t instanceof Promise ? t : Promise.resolve(t)).then((r) => (i.value = r, i.fallback = !0, i));
		if (t instanceof Promise) throw new de();
		return i.value = t, i.fallback = !0, i;
	};
});
function Gi(e, n) {
	return n === void 0 && (e.issues.length || e.fallback) ? {
		issues: [],
		value: void 0
	} : e;
}
const ir = d("$ZodOptional", (e, n) => {
	y.init(e, n), e._zod.optin = "optional", e._zod.optout = "optional", S(e._zod, "values", () => n.innerType._zod.values ? new Set([...n.innerType._zod.values, void 0]) : void 0), S(e._zod, "pattern", () => {
		const i = n.innerType._zod.pattern;
		return i ? new RegExp(`^(${Ut(i.source)})?$`) : void 0;
	}), e._zod.parse = (i, o) => {
		if (n.innerType._zod.optin === "optional") {
			const t = i.value, r = n.innerType._zod.run(i, o);
			return r instanceof Promise ? r.then((a) => Gi(a, t)) : Gi(r, t);
		}
		return i.value === void 0 ? i : n.innerType._zod.run(i, o);
	};
}), Au = d("$ZodExactOptional", (e, n) => {
	ir.init(e, n), S(e._zod, "values", () => n.innerType._zod.values), S(e._zod, "pattern", () => n.innerType._zod.pattern), e._zod.parse = (i, o) => n.innerType._zod.run(i, o);
}), Cu = d("$ZodNullable", (e, n) => {
	y.init(e, n), S(e._zod, "optin", () => n.innerType._zod.optin), S(e._zod, "optout", () => n.innerType._zod.optout), S(e._zod, "pattern", () => {
		const i = n.innerType._zod.pattern;
		return i ? new RegExp(`^(${Ut(i.source)}|null)$`) : void 0;
	}), S(e._zod, "values", () => n.innerType._zod.values ? new Set([...n.innerType._zod.values, null]) : void 0), e._zod.parse = (i, o) => i.value === null ? i : n.innerType._zod.run(i, o);
}), Ru = d("$ZodDefault", (e, n) => {
	y.init(e, n), e._zod.optin = "optional", S(e._zod, "values", () => n.innerType._zod.values), e._zod.parse = (i, o) => {
		if (o.direction === "backward") return n.innerType._zod.run(i, o);
		if (i.value === void 0) return i.value = n.defaultValue, i;
		const t = n.innerType._zod.run(i, o);
		return t instanceof Promise ? t.then((r) => Vi(r, n)) : Vi(t, n);
	};
});
function Vi(e, n) {
	return e.value === void 0 && (e.value = n.defaultValue), e;
}
const Lu = d("$ZodPrefault", (e, n) => {
	y.init(e, n), e._zod.optin = "optional", S(e._zod, "values", () => n.innerType._zod.values), e._zod.parse = (i, o) => (o.direction === "backward" || i.value === void 0 && (i.value = n.defaultValue), n.innerType._zod.run(i, o));
}), Fu = d("$ZodNonOptional", (e, n) => {
	y.init(e, n), S(e._zod, "values", () => {
		const i = n.innerType._zod.values;
		return i ? new Set([...i].filter((o) => o !== void 0)) : void 0;
	}), e._zod.parse = (i, o) => {
		const t = n.innerType._zod.run(i, o);
		return t instanceof Promise ? t.then((r) => Bi(r, e)) : Bi(t, e);
	};
});
function Bi(e, n) {
	return !e.issues.length && e.value === void 0 && e.issues.push({
		code: "invalid_type",
		expected: "nonoptional",
		input: e.value,
		inst: n
	}), e;
}
const Ju = d("$ZodSuccess", (e, n) => {
	y.init(e, n), e._zod.parse = (i, o) => {
		if (o.direction === "backward") throw new Zt("ZodSuccess");
		const t = n.innerType._zod.run(i, o);
		return t instanceof Promise ? t.then((r) => (i.value = r.issues.length === 0, i)) : (i.value = t.issues.length === 0, i);
	};
}), Mu = d("$ZodCatch", (e, n) => {
	y.init(e, n), e._zod.optin = "optional", S(e._zod, "optout", () => n.innerType._zod.optout), S(e._zod, "values", () => n.innerType._zod.values), e._zod.parse = (i, o) => {
		if (o.direction === "backward") return n.innerType._zod.run(i, o);
		const t = n.innerType._zod.run(i, o);
		return t instanceof Promise ? t.then((r) => (i.value = r.value, r.issues.length && (i.value = n.catchValue({
			...i,
			error: { issues: r.issues.map((a) => R(a, o, P())) },
			input: i.value
		}), i.issues = [], i.fallback = !0), i)) : (i.value = t.value, t.issues.length && (i.value = n.catchValue({
			...i,
			error: { issues: t.issues.map((r) => R(r, o, P())) },
			input: i.value
		}), i.issues = [], i.fallback = !0), i);
	};
}), Ku = d("$ZodNaN", (e, n) => {
	y.init(e, n), e._zod.parse = (i, o) => ((typeof i.value != "number" || !Number.isNaN(i.value)) && i.issues.push({
		input: i.value,
		inst: e,
		expected: "nan",
		code: "invalid_type"
	}), i);
}), or = d("$ZodPipe", (e, n) => {
	y.init(e, n), S(e._zod, "values", () => n.in._zod.values), S(e._zod, "optin", () => n.in._zod.optin), S(e._zod, "optout", () => n.out._zod.optout), S(e._zod, "propValues", () => n.in._zod.propValues), e._zod.parse = (i, o) => {
		if (o.direction === "backward") {
			const r = n.out._zod.run(i, o);
			return r instanceof Promise ? r.then((a) => vt(a, n.in, o)) : vt(r, n.in, o);
		}
		const t = n.in._zod.run(i, o);
		return t instanceof Promise ? t.then((r) => vt(r, n.out, o)) : vt(t, n.out, o);
	};
});
function vt(e, n, i) {
	return e.issues.length ? (e.aborted = !0, e) : n._zod.run({
		value: e.value,
		issues: e.issues,
		fallback: e.fallback
	}, i);
}
const ar = d("$ZodCodec", (e, n) => {
	y.init(e, n), S(e._zod, "values", () => n.in._zod.values), S(e._zod, "optin", () => n.in._zod.optin), S(e._zod, "optout", () => n.out._zod.optout), S(e._zod, "propValues", () => n.in._zod.propValues), e._zod.parse = (i, o) => {
		if ((o.direction || "forward") === "forward") {
			const t = n.in._zod.run(i, o);
			return t instanceof Promise ? t.then((r) => gt(r, n, o)) : gt(t, n, o);
		} else {
			const t = n.out._zod.run(i, o);
			return t instanceof Promise ? t.then((r) => gt(r, n, o)) : gt(t, n, o);
		}
	};
});
function gt(e, n, i) {
	if (e.issues.length) return e.aborted = !0, e;
	if ((i.direction || "forward") === "forward") {
		const o = n.transform(e.value, e);
		return o instanceof Promise ? o.then((t) => ht(e, t, n.out, i)) : ht(e, o, n.out, i);
	} else {
		const o = n.reverseTransform(e.value, e);
		return o instanceof Promise ? o.then((t) => ht(e, t, n.in, i)) : ht(e, o, n.in, i);
	}
}
function ht(e, n, i, o) {
	return e.issues.length ? (e.aborted = !0, e) : i._zod.run({
		value: n,
		issues: e.issues
	}, o);
}
const Gu = d("$ZodPreprocess", (e, n) => {
	or.init(e, n);
}), Vu = d("$ZodReadonly", (e, n) => {
	y.init(e, n), S(e._zod, "propValues", () => n.innerType._zod.propValues), S(e._zod, "values", () => n.innerType._zod.values), S(e._zod, "optin", () => n.innerType?._zod?.optin), S(e._zod, "optout", () => n.innerType?._zod?.optout), e._zod.parse = (i, o) => {
		if (o.direction === "backward") return n.innerType._zod.run(i, o);
		const t = n.innerType._zod.run(i, o);
		return t instanceof Promise ? t.then(Wi) : Wi(t);
	};
});
function Wi(e) {
	return e.value = Object.freeze(e.value), e;
}
const Bu = d("$ZodTemplateLiteral", (e, n) => {
	y.init(e, n);
	const i = [];
	for (const o of n.parts) if (typeof o == "object" && o !== null) {
		if (!o._zod.pattern) throw new Error(`Invalid template literal part, no pattern found: ${[...o._zod.traits].shift()}`);
		const t = o._zod.pattern instanceof RegExp ? o._zod.pattern.source : o._zod.pattern;
		if (!t) throw new Error(`Invalid template literal part: ${o._zod.traits}`);
		const r = t.startsWith("^") ? 1 : 0, a = t.endsWith("$") ? t.length - 1 : t.length;
		i.push(t.slice(r, a));
	} else if (o === null || $o.has(typeof o)) i.push(H(`${o}`));
	else throw new Error(`Invalid template literal part: ${o}`);
	e._zod.pattern = new RegExp(`^${i.join("")}$`), e._zod.parse = (o, t) => typeof o.value != "string" ? (o.issues.push({
		input: o.value,
		inst: e,
		expected: "string",
		code: "invalid_type"
	}), o) : (e._zod.pattern.lastIndex = 0, e._zod.pattern.test(o.value) || o.issues.push({
		input: o.value,
		inst: e,
		code: "invalid_format",
		format: n.format ?? "template_literal",
		pattern: e._zod.pattern.source
	}), o);
}), Wu = d("$ZodFunction", (e, n) => (y.init(e, n), e._def = n, e._zod.def = n, e.implement = (i) => {
	if (typeof i != "function") throw new Error("implement() must be called with a function");
	return function(...o) {
		const t = e._def.input ? zn(e._def.input, o) : o, r = Reflect.apply(i, this, t);
		return e._def.output ? zn(e._def.output, r) : r;
	};
}, e.implementAsync = (i) => {
	if (typeof i != "function") throw new Error("implementAsync() must be called with a function");
	return async function(...o) {
		const t = e._def.input ? await wn(e._def.input, o) : o, r = await Reflect.apply(i, this, t);
		return e._def.output ? await wn(e._def.output, r) : r;
	};
}, e._zod.parse = (i, o) => typeof i.value != "function" ? (i.issues.push({
	code: "invalid_type",
	expected: "function",
	input: i.value,
	inst: e
}), i) : (e._def.output && e._def.output._zod.def.type === "promise" ? i.value = e.implementAsync(i.value) : i.value = e.implement(i.value), i), e.input = (...i) => {
	const o = e.constructor;
	return Array.isArray(i[0]) ? new o({
		type: "function",
		input: new rr({
			type: "tuple",
			items: i[0],
			rest: i[1]
		}),
		output: e._def.output
	}) : new o({
		type: "function",
		input: i[0],
		output: e._def.output
	});
}, e.output = (i) => {
	const o = e.constructor;
	return new o({
		type: "function",
		input: e._def.input,
		output: i
	});
}, e)), Xu = d("$ZodPromise", (e, n) => {
	y.init(e, n), e._zod.parse = (i, o) => Promise.resolve(i.value).then((t) => n.innerType._zod.run({
		value: t,
		issues: []
	}, o));
}), qu = d("$ZodLazy", (e, n) => {
	y.init(e, n), S(e._zod, "innerType", () => {
		const i = n;
		return i._cachedInner || (i._cachedInner = n.getter()), i._cachedInner;
	}), S(e._zod, "pattern", () => e._zod.innerType?._zod?.pattern), S(e._zod, "propValues", () => e._zod.innerType?._zod?.propValues), S(e._zod, "optin", () => e._zod.innerType?._zod?.optin ?? void 0), S(e._zod, "optout", () => e._zod.innerType?._zod?.optout ?? void 0), e._zod.parse = (i, o) => e._zod.innerType._zod.run(i, o);
}), Yu = d("$ZodCustom", (e, n) => {
	D.init(e, n), y.init(e, n), e._zod.parse = (i, o) => i, e._zod.check = (i) => {
		const o = i.value, t = n.fn(o);
		if (t instanceof Promise) return t.then((r) => Xi(r, i, o, e));
		Xi(t, i, o, e);
	};
});
function Xi(e, n, i, o) {
	if (!e) {
		const t = {
			code: "custom",
			input: i,
			inst: o,
			path: [...o._zod.def.path ?? []],
			continue: !o._zod.def.abort
		};
		o._zod.def.params && (t.params = o._zod.def.params), n.issues.push(ke(t));
	}
}
const pm = () => {
	const e = {
		string: {
			unit: "حرف",
			verb: "أن يحوي"
		},
		file: {
			unit: "بايت",
			verb: "أن يحوي"
		},
		array: {
			unit: "عنصر",
			verb: "أن يحوي"
		},
		set: {
			unit: "عنصر",
			verb: "أن يحوي"
		}
	};
	function n(t) {
		return e[t] ?? null;
	}
	const i = {
		regex: "مدخل",
		email: "بريد إلكتروني",
		url: "رابط",
		emoji: "إيموجي",
		uuid: "UUID",
		uuidv4: "UUIDv4",
		uuidv6: "UUIDv6",
		nanoid: "nanoid",
		guid: "GUID",
		cuid: "cuid",
		cuid2: "cuid2",
		ulid: "ULID",
		xid: "XID",
		ksuid: "KSUID",
		datetime: "تاريخ ووقت بمعيار ISO",
		date: "تاريخ بمعيار ISO",
		time: "وقت بمعيار ISO",
		duration: "مدة بمعيار ISO",
		ipv4: "عنوان IPv4",
		ipv6: "عنوان IPv6",
		cidrv4: "مدى عناوين بصيغة IPv4",
		cidrv6: "مدى عناوين بصيغة IPv6",
		base64: "نَص بترميز base64-encoded",
		base64url: "نَص بترميز base64url-encoded",
		json_string: "نَص على هيئة JSON",
		e164: "رقم هاتف بمعيار E.164",
		jwt: "JWT",
		template_literal: "مدخل"
	}, o = { nan: "NaN" };
	return (t) => {
		switch (t.code) {
			case "invalid_type": {
				const r = o[t.expected] ?? t.expected, a = b(t.input), u = o[a] ?? a;
				return /^[A-Z]/.test(t.expected) ? `مدخلات غير مقبولة: يفترض إدخال instanceof ${t.expected}، ولكن تم إدخال ${u}` : `مدخلات غير مقبولة: يفترض إدخال ${r}، ولكن تم إدخال ${u}`;
			}
			case "invalid_value": return t.values.length === 1 ? `مدخلات غير مقبولة: يفترض إدخال ${_(t.values[0])}` : `اختيار غير مقبول: يتوقع انتقاء أحد هذه الخيارات: ${v(t.values, "|")}`;
			case "too_big": {
				const r = t.inclusive ? "<=" : "<", a = n(t.origin);
				return a ? ` أكبر من اللازم: يفترض أن تكون ${t.origin ?? "القيمة"} ${r} ${t.maximum.toString()} ${a.unit ?? "عنصر"}` : `أكبر من اللازم: يفترض أن تكون ${t.origin ?? "القيمة"} ${r} ${t.maximum.toString()}`;
			}
			case "too_small": {
				const r = t.inclusive ? ">=" : ">", a = n(t.origin);
				return a ? `أصغر من اللازم: يفترض لـ ${t.origin} أن يكون ${r} ${t.minimum.toString()} ${a.unit}` : `أصغر من اللازم: يفترض لـ ${t.origin} أن يكون ${r} ${t.minimum.toString()}`;
			}
			case "invalid_format": {
				const r = t;
				return r.format === "starts_with" ? `نَص غير مقبول: يجب أن يبدأ بـ "${t.prefix}"` : r.format === "ends_with" ? `نَص غير مقبول: يجب أن ينتهي بـ "${r.suffix}"` : r.format === "includes" ? `نَص غير مقبول: يجب أن يتضمَّن "${r.includes}"` : r.format === "regex" ? `نَص غير مقبول: يجب أن يطابق النمط ${r.pattern}` : `${i[r.format] ?? t.format} غير مقبول`;
			}
			case "not_multiple_of": return `رقم غير مقبول: يجب أن يكون من مضاعفات ${t.divisor}`;
			case "unrecognized_keys": return `معرف${t.keys.length > 1 ? "ات" : ""} غريب${t.keys.length > 1 ? "ة" : ""}: ${v(t.keys, "، ")}`;
			case "invalid_key": return `معرف غير مقبول في ${t.origin}`;
			case "invalid_union": return "مدخل غير مقبول";
			case "invalid_element": return `مدخل غير مقبول في ${t.origin}`;
			default: return "مدخل غير مقبول";
		}
	};
};
function vm() {
	return { localeError: pm() };
}
const gm = () => {
	const e = {
		string: {
			unit: "simvol",
			verb: "olmalıdır"
		},
		file: {
			unit: "bayt",
			verb: "olmalıdır"
		},
		array: {
			unit: "element",
			verb: "olmalıdır"
		},
		set: {
			unit: "element",
			verb: "olmalıdır"
		}
	};
	function n(t) {
		return e[t] ?? null;
	}
	const i = {
		regex: "input",
		email: "email address",
		url: "URL",
		emoji: "emoji",
		uuid: "UUID",
		uuidv4: "UUIDv4",
		uuidv6: "UUIDv6",
		nanoid: "nanoid",
		guid: "GUID",
		cuid: "cuid",
		cuid2: "cuid2",
		ulid: "ULID",
		xid: "XID",
		ksuid: "KSUID",
		datetime: "ISO datetime",
		date: "ISO date",
		time: "ISO time",
		duration: "ISO duration",
		ipv4: "IPv4 address",
		ipv6: "IPv6 address",
		cidrv4: "IPv4 range",
		cidrv6: "IPv6 range",
		base64: "base64-encoded string",
		base64url: "base64url-encoded string",
		json_string: "JSON string",
		e164: "E.164 number",
		jwt: "JWT",
		template_literal: "input"
	}, o = { nan: "NaN" };
	return (t) => {
		switch (t.code) {
			case "invalid_type": {
				const r = o[t.expected] ?? t.expected, a = b(t.input), u = o[a] ?? a;
				return /^[A-Z]/.test(t.expected) ? `Yanlış dəyər: gözlənilən instanceof ${t.expected}, daxil olan ${u}` : `Yanlış dəyər: gözlənilən ${r}, daxil olan ${u}`;
			}
			case "invalid_value": return t.values.length === 1 ? `Yanlış dəyər: gözlənilən ${_(t.values[0])}` : `Yanlış seçim: aşağıdakılardan biri olmalıdır: ${v(t.values, "|")}`;
			case "too_big": {
				const r = t.inclusive ? "<=" : "<", a = n(t.origin);
				return a ? `Çox böyük: gözlənilən ${t.origin ?? "dəyər"} ${r}${t.maximum.toString()} ${a.unit ?? "element"}` : `Çox böyük: gözlənilən ${t.origin ?? "dəyər"} ${r}${t.maximum.toString()}`;
			}
			case "too_small": {
				const r = t.inclusive ? ">=" : ">", a = n(t.origin);
				return a ? `Çox kiçik: gözlənilən ${t.origin} ${r}${t.minimum.toString()} ${a.unit}` : `Çox kiçik: gözlənilən ${t.origin} ${r}${t.minimum.toString()}`;
			}
			case "invalid_format": {
				const r = t;
				return r.format === "starts_with" ? `Yanlış mətn: "${r.prefix}" ilə başlamalıdır` : r.format === "ends_with" ? `Yanlış mətn: "${r.suffix}" ilə bitməlidir` : r.format === "includes" ? `Yanlış mətn: "${r.includes}" daxil olmalıdır` : r.format === "regex" ? `Yanlış mətn: ${r.pattern} şablonuna uyğun olmalıdır` : `Yanlış ${i[r.format] ?? t.format}`;
			}
			case "not_multiple_of": return `Yanlış ədəd: ${t.divisor} ilə bölünə bilən olmalıdır`;
			case "unrecognized_keys": return `Tanınmayan açar${t.keys.length > 1 ? "lar" : ""}: ${v(t.keys, ", ")}`;
			case "invalid_key": return `${t.origin} daxilində yanlış açar`;
			case "invalid_union": return "Yanlış dəyər";
			case "invalid_element": return `${t.origin} daxilində yanlış dəyər`;
			default: return "Yanlış dəyər";
		}
	};
};
function hm() {
	return { localeError: gm() };
}
function qi(e, n, i, o) {
	const t = Math.abs(e), r = t % 10, a = t % 100;
	return a >= 11 && a <= 19 ? o : r === 1 ? n : r >= 2 && r <= 4 ? i : o;
}
const $m = () => {
	const e = {
		string: {
			unit: {
				one: "сімвал",
				few: "сімвалы",
				many: "сімвалаў"
			},
			verb: "мець"
		},
		array: {
			unit: {
				one: "элемент",
				few: "элементы",
				many: "элементаў"
			},
			verb: "мець"
		},
		set: {
			unit: {
				one: "элемент",
				few: "элементы",
				many: "элементаў"
			},
			verb: "мець"
		},
		file: {
			unit: {
				one: "байт",
				few: "байты",
				many: "байтаў"
			},
			verb: "мець"
		}
	};
	function n(t) {
		return e[t] ?? null;
	}
	const i = {
		regex: "увод",
		email: "email адрас",
		url: "URL",
		emoji: "эмодзі",
		uuid: "UUID",
		uuidv4: "UUIDv4",
		uuidv6: "UUIDv6",
		nanoid: "nanoid",
		guid: "GUID",
		cuid: "cuid",
		cuid2: "cuid2",
		ulid: "ULID",
		xid: "XID",
		ksuid: "KSUID",
		datetime: "ISO дата і час",
		date: "ISO дата",
		time: "ISO час",
		duration: "ISO працягласць",
		ipv4: "IPv4 адрас",
		ipv6: "IPv6 адрас",
		cidrv4: "IPv4 дыяпазон",
		cidrv6: "IPv6 дыяпазон",
		base64: "радок у фармаце base64",
		base64url: "радок у фармаце base64url",
		json_string: "JSON радок",
		e164: "нумар E.164",
		jwt: "JWT",
		template_literal: "увод"
	}, o = {
		nan: "NaN",
		number: "лік",
		array: "масіў"
	};
	return (t) => {
		switch (t.code) {
			case "invalid_type": {
				const r = o[t.expected] ?? t.expected, a = b(t.input), u = o[a] ?? a;
				return /^[A-Z]/.test(t.expected) ? `Няправільны ўвод: чакаўся instanceof ${t.expected}, атрымана ${u}` : `Няправільны ўвод: чакаўся ${r}, атрымана ${u}`;
			}
			case "invalid_value": return t.values.length === 1 ? `Няправільны ўвод: чакалася ${_(t.values[0])}` : `Няправільны варыянт: чакаўся адзін з ${v(t.values, "|")}`;
			case "too_big": {
				const r = t.inclusive ? "<=" : "<", a = n(t.origin);
				if (a) {
					const u = qi(Number(t.maximum), a.unit.one, a.unit.few, a.unit.many);
					return `Занадта вялікі: чакалася, што ${t.origin ?? "значэнне"} павінна ${a.verb} ${r}${t.maximum.toString()} ${u}`;
				}
				return `Занадта вялікі: чакалася, што ${t.origin ?? "значэнне"} павінна быць ${r}${t.maximum.toString()}`;
			}
			case "too_small": {
				const r = t.inclusive ? ">=" : ">", a = n(t.origin);
				if (a) {
					const u = qi(Number(t.minimum), a.unit.one, a.unit.few, a.unit.many);
					return `Занадта малы: чакалася, што ${t.origin} павінна ${a.verb} ${r}${t.minimum.toString()} ${u}`;
				}
				return `Занадта малы: чакалася, што ${t.origin} павінна быць ${r}${t.minimum.toString()}`;
			}
			case "invalid_format": {
				const r = t;
				return r.format === "starts_with" ? `Няправільны радок: павінен пачынацца з "${r.prefix}"` : r.format === "ends_with" ? `Няправільны радок: павінен заканчвацца на "${r.suffix}"` : r.format === "includes" ? `Няправільны радок: павінен змяшчаць "${r.includes}"` : r.format === "regex" ? `Няправільны радок: павінен адпавядаць шаблону ${r.pattern}` : `Няправільны ${i[r.format] ?? t.format}`;
			}
			case "not_multiple_of": return `Няправільны лік: павінен быць кратным ${t.divisor}`;
			case "unrecognized_keys": return `Нераспазнаны ${t.keys.length > 1 ? "ключы" : "ключ"}: ${v(t.keys, ", ")}`;
			case "invalid_key": return `Няправільны ключ у ${t.origin}`;
			case "invalid_union": return "Няправільны ўвод";
			case "invalid_element": return `Няправільнае значэнне ў ${t.origin}`;
			default: return "Няправільны ўвод";
		}
	};
};
function _m() {
	return { localeError: $m() };
}
const bm = () => {
	const e = {
		string: {
			unit: "символа",
			verb: "да съдържа"
		},
		file: {
			unit: "байта",
			verb: "да съдържа"
		},
		array: {
			unit: "елемента",
			verb: "да съдържа"
		},
		set: {
			unit: "елемента",
			verb: "да съдържа"
		}
	};
	function n(t) {
		return e[t] ?? null;
	}
	const i = {
		regex: "вход",
		email: "имейл адрес",
		url: "URL",
		emoji: "емоджи",
		uuid: "UUID",
		uuidv4: "UUIDv4",
		uuidv6: "UUIDv6",
		nanoid: "nanoid",
		guid: "GUID",
		cuid: "cuid",
		cuid2: "cuid2",
		ulid: "ULID",
		xid: "XID",
		ksuid: "KSUID",
		datetime: "ISO време",
		date: "ISO дата",
		time: "ISO време",
		duration: "ISO продължителност",
		ipv4: "IPv4 адрес",
		ipv6: "IPv6 адрес",
		cidrv4: "IPv4 диапазон",
		cidrv6: "IPv6 диапазон",
		base64: "base64-кодиран низ",
		base64url: "base64url-кодиран низ",
		json_string: "JSON низ",
		e164: "E.164 номер",
		jwt: "JWT",
		template_literal: "вход"
	}, o = {
		nan: "NaN",
		number: "число",
		array: "масив"
	};
	return (t) => {
		switch (t.code) {
			case "invalid_type": {
				const r = o[t.expected] ?? t.expected, a = b(t.input), u = o[a] ?? a;
				return /^[A-Z]/.test(t.expected) ? `Невалиден вход: очакван instanceof ${t.expected}, получен ${u}` : `Невалиден вход: очакван ${r}, получен ${u}`;
			}
			case "invalid_value": return t.values.length === 1 ? `Невалиден вход: очакван ${_(t.values[0])}` : `Невалидна опция: очаквано едно от ${v(t.values, "|")}`;
			case "too_big": {
				const r = t.inclusive ? "<=" : "<", a = n(t.origin);
				return a ? `Твърде голямо: очаква се ${t.origin ?? "стойност"} да съдържа ${r}${t.maximum.toString()} ${a.unit ?? "елемента"}` : `Твърде голямо: очаква се ${t.origin ?? "стойност"} да бъде ${r}${t.maximum.toString()}`;
			}
			case "too_small": {
				const r = t.inclusive ? ">=" : ">", a = n(t.origin);
				return a ? `Твърде малко: очаква се ${t.origin} да съдържа ${r}${t.minimum.toString()} ${a.unit}` : `Твърде малко: очаква се ${t.origin} да бъде ${r}${t.minimum.toString()}`;
			}
			case "invalid_format": {
				const r = t;
				if (r.format === "starts_with") return `Невалиден низ: трябва да започва с "${r.prefix}"`;
				if (r.format === "ends_with") return `Невалиден низ: трябва да завършва с "${r.suffix}"`;
				if (r.format === "includes") return `Невалиден низ: трябва да включва "${r.includes}"`;
				if (r.format === "regex") return `Невалиден низ: трябва да съвпада с ${r.pattern}`;
				let a = "Невалиден";
				return r.format === "emoji" && (a = "Невалидно"), r.format === "datetime" && (a = "Невалидно"), r.format === "date" && (a = "Невалидна"), r.format === "time" && (a = "Невалидно"), r.format === "duration" && (a = "Невалидна"), `${a} ${i[r.format] ?? t.format}`;
			}
			case "not_multiple_of": return `Невалидно число: трябва да бъде кратно на ${t.divisor}`;
			case "unrecognized_keys": return `Неразпознат${t.keys.length > 1 ? "и" : ""} ключ${t.keys.length > 1 ? "ове" : ""}: ${v(t.keys, ", ")}`;
			case "invalid_key": return `Невалиден ключ в ${t.origin}`;
			case "invalid_union": return "Невалиден вход";
			case "invalid_element": return `Невалидна стойност в ${t.origin}`;
			default: return "Невалиден вход";
		}
	};
};
function ym() {
	return { localeError: bm() };
}
const km = () => {
	const e = {
		string: {
			unit: "caràcters",
			verb: "contenir"
		},
		file: {
			unit: "bytes",
			verb: "contenir"
		},
		array: {
			unit: "elements",
			verb: "contenir"
		},
		set: {
			unit: "elements",
			verb: "contenir"
		}
	};
	function n(t) {
		return e[t] ?? null;
	}
	const i = {
		regex: "entrada",
		email: "adreça electrònica",
		url: "URL",
		emoji: "emoji",
		uuid: "UUID",
		uuidv4: "UUIDv4",
		uuidv6: "UUIDv6",
		nanoid: "nanoid",
		guid: "GUID",
		cuid: "cuid",
		cuid2: "cuid2",
		ulid: "ULID",
		xid: "XID",
		ksuid: "KSUID",
		datetime: "data i hora ISO",
		date: "data ISO",
		time: "hora ISO",
		duration: "durada ISO",
		ipv4: "adreça IPv4",
		ipv6: "adreça IPv6",
		cidrv4: "rang IPv4",
		cidrv6: "rang IPv6",
		base64: "cadena codificada en base64",
		base64url: "cadena codificada en base64url",
		json_string: "cadena JSON",
		e164: "número E.164",
		jwt: "JWT",
		template_literal: "entrada"
	}, o = { nan: "NaN" };
	return (t) => {
		switch (t.code) {
			case "invalid_type": {
				const r = o[t.expected] ?? t.expected, a = b(t.input), u = o[a] ?? a;
				return /^[A-Z]/.test(t.expected) ? `Tipus invàlid: s'esperava instanceof ${t.expected}, s'ha rebut ${u}` : `Tipus invàlid: s'esperava ${r}, s'ha rebut ${u}`;
			}
			case "invalid_value": return t.values.length === 1 ? `Valor invàlid: s'esperava ${_(t.values[0])}` : `Opció invàlida: s'esperava una de ${v(t.values, " o ")}`;
			case "too_big": {
				const r = t.inclusive ? "com a màxim" : "menys de", a = n(t.origin);
				return a ? `Massa gran: s'esperava que ${t.origin ?? "el valor"} contingués ${r} ${t.maximum.toString()} ${a.unit ?? "elements"}` : `Massa gran: s'esperava que ${t.origin ?? "el valor"} fos ${r} ${t.maximum.toString()}`;
			}
			case "too_small": {
				const r = t.inclusive ? "com a mínim" : "més de", a = n(t.origin);
				return a ? `Massa petit: s'esperava que ${t.origin} contingués ${r} ${t.minimum.toString()} ${a.unit}` : `Massa petit: s'esperava que ${t.origin} fos ${r} ${t.minimum.toString()}`;
			}
			case "invalid_format": {
				const r = t;
				return r.format === "starts_with" ? `Format invàlid: ha de començar amb "${r.prefix}"` : r.format === "ends_with" ? `Format invàlid: ha d'acabar amb "${r.suffix}"` : r.format === "includes" ? `Format invàlid: ha d'incloure "${r.includes}"` : r.format === "regex" ? `Format invàlid: ha de coincidir amb el patró ${r.pattern}` : `Format invàlid per a ${i[r.format] ?? t.format}`;
			}
			case "not_multiple_of": return `Número invàlid: ha de ser múltiple de ${t.divisor}`;
			case "unrecognized_keys": return `Clau${t.keys.length > 1 ? "s" : ""} no reconeguda${t.keys.length > 1 ? "s" : ""}: ${v(t.keys, ", ")}`;
			case "invalid_key": return `Clau invàlida a ${t.origin}`;
			case "invalid_union": return "Entrada invàlida";
			case "invalid_element": return `Element invàlid a ${t.origin}`;
			default: return "Entrada invàlida";
		}
	};
};
function Sm() {
	return { localeError: km() };
}
const Im = () => {
	const e = {
		string: {
			unit: "znaků",
			verb: "mít"
		},
		file: {
			unit: "bajtů",
			verb: "mít"
		},
		array: {
			unit: "prvků",
			verb: "mít"
		},
		set: {
			unit: "prvků",
			verb: "mít"
		}
	};
	function n(t) {
		return e[t] ?? null;
	}
	const i = {
		regex: "regulární výraz",
		email: "e-mailová adresa",
		url: "URL",
		emoji: "emoji",
		uuid: "UUID",
		uuidv4: "UUIDv4",
		uuidv6: "UUIDv6",
		nanoid: "nanoid",
		guid: "GUID",
		cuid: "cuid",
		cuid2: "cuid2",
		ulid: "ULID",
		xid: "XID",
		ksuid: "KSUID",
		datetime: "datum a čas ve formátu ISO",
		date: "datum ve formátu ISO",
		time: "čas ve formátu ISO",
		duration: "doba trvání ISO",
		ipv4: "IPv4 adresa",
		ipv6: "IPv6 adresa",
		cidrv4: "rozsah IPv4",
		cidrv6: "rozsah IPv6",
		base64: "řetězec zakódovaný ve formátu base64",
		base64url: "řetězec zakódovaný ve formátu base64url",
		json_string: "řetězec ve formátu JSON",
		e164: "číslo E.164",
		jwt: "JWT",
		template_literal: "vstup"
	}, o = {
		nan: "NaN",
		number: "číslo",
		string: "řetězec",
		function: "funkce",
		array: "pole"
	};
	return (t) => {
		switch (t.code) {
			case "invalid_type": {
				const r = o[t.expected] ?? t.expected, a = b(t.input), u = o[a] ?? a;
				return /^[A-Z]/.test(t.expected) ? `Neplatný vstup: očekáváno instanceof ${t.expected}, obdrženo ${u}` : `Neplatný vstup: očekáváno ${r}, obdrženo ${u}`;
			}
			case "invalid_value": return t.values.length === 1 ? `Neplatný vstup: očekáváno ${_(t.values[0])}` : `Neplatná možnost: očekávána jedna z hodnot ${v(t.values, "|")}`;
			case "too_big": {
				const r = t.inclusive ? "<=" : "<", a = n(t.origin);
				return a ? `Hodnota je příliš velká: ${t.origin ?? "hodnota"} musí mít ${r}${t.maximum.toString()} ${a.unit ?? "prvků"}` : `Hodnota je příliš velká: ${t.origin ?? "hodnota"} musí být ${r}${t.maximum.toString()}`;
			}
			case "too_small": {
				const r = t.inclusive ? ">=" : ">", a = n(t.origin);
				return a ? `Hodnota je příliš malá: ${t.origin ?? "hodnota"} musí mít ${r}${t.minimum.toString()} ${a.unit ?? "prvků"}` : `Hodnota je příliš malá: ${t.origin ?? "hodnota"} musí být ${r}${t.minimum.toString()}`;
			}
			case "invalid_format": {
				const r = t;
				return r.format === "starts_with" ? `Neplatný řetězec: musí začínat na "${r.prefix}"` : r.format === "ends_with" ? `Neplatný řetězec: musí končit na "${r.suffix}"` : r.format === "includes" ? `Neplatný řetězec: musí obsahovat "${r.includes}"` : r.format === "regex" ? `Neplatný řetězec: musí odpovídat vzoru ${r.pattern}` : `Neplatný formát ${i[r.format] ?? t.format}`;
			}
			case "not_multiple_of": return `Neplatné číslo: musí být násobkem ${t.divisor}`;
			case "unrecognized_keys": return `Neznámé klíče: ${v(t.keys, ", ")}`;
			case "invalid_key": return `Neplatný klíč v ${t.origin}`;
			case "invalid_union": return "Neplatný vstup";
			case "invalid_element": return `Neplatná hodnota v ${t.origin}`;
			default: return "Neplatný vstup";
		}
	};
};
function zm() {
	return { localeError: Im() };
}
const wm = () => {
	const e = {
		string: {
			unit: "tegn",
			verb: "havde"
		},
		file: {
			unit: "bytes",
			verb: "havde"
		},
		array: {
			unit: "elementer",
			verb: "indeholdt"
		},
		set: {
			unit: "elementer",
			verb: "indeholdt"
		}
	};
	function n(t) {
		return e[t] ?? null;
	}
	const i = {
		regex: "input",
		email: "e-mailadresse",
		url: "URL",
		emoji: "emoji",
		uuid: "UUID",
		uuidv4: "UUIDv4",
		uuidv6: "UUIDv6",
		nanoid: "nanoid",
		guid: "GUID",
		cuid: "cuid",
		cuid2: "cuid2",
		ulid: "ULID",
		xid: "XID",
		ksuid: "KSUID",
		datetime: "ISO dato- og klokkeslæt",
		date: "ISO-dato",
		time: "ISO-klokkeslæt",
		duration: "ISO-varighed",
		ipv4: "IPv4-område",
		ipv6: "IPv6-område",
		cidrv4: "IPv4-spektrum",
		cidrv6: "IPv6-spektrum",
		base64: "base64-kodet streng",
		base64url: "base64url-kodet streng",
		json_string: "JSON-streng",
		e164: "E.164-nummer",
		jwt: "JWT",
		template_literal: "input"
	}, o = {
		nan: "NaN",
		string: "streng",
		number: "tal",
		boolean: "boolean",
		array: "liste",
		object: "objekt",
		set: "sæt",
		file: "fil"
	};
	return (t) => {
		switch (t.code) {
			case "invalid_type": {
				const r = o[t.expected] ?? t.expected, a = b(t.input), u = o[a] ?? a;
				return /^[A-Z]/.test(t.expected) ? `Ugyldigt input: forventede instanceof ${t.expected}, fik ${u}` : `Ugyldigt input: forventede ${r}, fik ${u}`;
			}
			case "invalid_value": return t.values.length === 1 ? `Ugyldig værdi: forventede ${_(t.values[0])}` : `Ugyldigt valg: forventede en af følgende ${v(t.values, "|")}`;
			case "too_big": {
				const r = t.inclusive ? "<=" : "<", a = n(t.origin), u = o[t.origin] ?? t.origin;
				return a ? `For stor: forventede ${u ?? "value"} ${a.verb} ${r} ${t.maximum.toString()} ${a.unit ?? "elementer"}` : `For stor: forventede ${u ?? "value"} havde ${r} ${t.maximum.toString()}`;
			}
			case "too_small": {
				const r = t.inclusive ? ">=" : ">", a = n(t.origin), u = o[t.origin] ?? t.origin;
				return a ? `For lille: forventede ${u} ${a.verb} ${r} ${t.minimum.toString()} ${a.unit}` : `For lille: forventede ${u} havde ${r} ${t.minimum.toString()}`;
			}
			case "invalid_format": {
				const r = t;
				return r.format === "starts_with" ? `Ugyldig streng: skal starte med "${r.prefix}"` : r.format === "ends_with" ? `Ugyldig streng: skal ende med "${r.suffix}"` : r.format === "includes" ? `Ugyldig streng: skal indeholde "${r.includes}"` : r.format === "regex" ? `Ugyldig streng: skal matche mønsteret ${r.pattern}` : `Ugyldig ${i[r.format] ?? t.format}`;
			}
			case "not_multiple_of": return `Ugyldigt tal: skal være deleligt med ${t.divisor}`;
			case "unrecognized_keys": return `${t.keys.length > 1 ? "Ukendte nøgler" : "Ukendt nøgle"}: ${v(t.keys, ", ")}`;
			case "invalid_key": return `Ugyldig nøgle i ${t.origin}`;
			case "invalid_union": return "Ugyldigt input: matcher ingen af de tilladte typer";
			case "invalid_element": return `Ugyldig værdi i ${t.origin}`;
			default: return "Ugyldigt input";
		}
	};
};
function xm() {
	return { localeError: wm() };
}
const Zm = () => {
	const e = {
		string: {
			unit: "Zeichen",
			verb: "zu haben"
		},
		file: {
			unit: "Bytes",
			verb: "zu haben"
		},
		array: {
			unit: "Elemente",
			verb: "zu haben"
		},
		set: {
			unit: "Elemente",
			verb: "zu haben"
		}
	};
	function n(t) {
		return e[t] ?? null;
	}
	const i = {
		regex: "Eingabe",
		email: "E-Mail-Adresse",
		url: "URL",
		emoji: "Emoji",
		uuid: "UUID",
		uuidv4: "UUIDv4",
		uuidv6: "UUIDv6",
		nanoid: "nanoid",
		guid: "GUID",
		cuid: "cuid",
		cuid2: "cuid2",
		ulid: "ULID",
		xid: "XID",
		ksuid: "KSUID",
		datetime: "ISO-Datum und -Uhrzeit",
		date: "ISO-Datum",
		time: "ISO-Uhrzeit",
		duration: "ISO-Dauer",
		ipv4: "IPv4-Adresse",
		ipv6: "IPv6-Adresse",
		cidrv4: "IPv4-Bereich",
		cidrv6: "IPv6-Bereich",
		base64: "Base64-codierter String",
		base64url: "Base64-URL-codierter String",
		json_string: "JSON-String",
		e164: "E.164-Nummer",
		jwt: "JWT",
		template_literal: "Eingabe"
	}, o = {
		nan: "NaN",
		number: "Zahl",
		array: "Array"
	};
	return (t) => {
		switch (t.code) {
			case "invalid_type": {
				const r = o[t.expected] ?? t.expected, a = b(t.input), u = o[a] ?? a;
				return /^[A-Z]/.test(t.expected) ? `Ungültige Eingabe: erwartet instanceof ${t.expected}, erhalten ${u}` : `Ungültige Eingabe: erwartet ${r}, erhalten ${u}`;
			}
			case "invalid_value": return t.values.length === 1 ? `Ungültige Eingabe: erwartet ${_(t.values[0])}` : `Ungültige Option: erwartet eine von ${v(t.values, "|")}`;
			case "too_big": {
				const r = t.inclusive ? "<=" : "<", a = n(t.origin);
				return a ? `Zu groß: erwartet, dass ${t.origin ?? "Wert"} ${r}${t.maximum.toString()} ${a.unit ?? "Elemente"} hat` : `Zu groß: erwartet, dass ${t.origin ?? "Wert"} ${r}${t.maximum.toString()} ist`;
			}
			case "too_small": {
				const r = t.inclusive ? ">=" : ">", a = n(t.origin);
				return a ? `Zu klein: erwartet, dass ${t.origin} ${r}${t.minimum.toString()} ${a.unit} hat` : `Zu klein: erwartet, dass ${t.origin} ${r}${t.minimum.toString()} ist`;
			}
			case "invalid_format": {
				const r = t;
				return r.format === "starts_with" ? `Ungültiger String: muss mit "${r.prefix}" beginnen` : r.format === "ends_with" ? `Ungültiger String: muss mit "${r.suffix}" enden` : r.format === "includes" ? `Ungültiger String: muss "${r.includes}" enthalten` : r.format === "regex" ? `Ungültiger String: muss dem Muster ${r.pattern} entsprechen` : `Ungültig: ${i[r.format] ?? t.format}`;
			}
			case "not_multiple_of": return `Ungültige Zahl: muss ein Vielfaches von ${t.divisor} sein`;
			case "unrecognized_keys": return `${t.keys.length > 1 ? "Unbekannte Schlüssel" : "Unbekannter Schlüssel"}: ${v(t.keys, ", ")}`;
			case "invalid_key": return `Ungültiger Schlüssel in ${t.origin}`;
			case "invalid_union": return "Ungültige Eingabe";
			case "invalid_element": return `Ungültiger Wert in ${t.origin}`;
			default: return "Ungültige Eingabe";
		}
	};
};
function Um() {
	return { localeError: Zm() };
}
const jm = () => {
	const e = {
		string: {
			unit: "χαρακτήρες",
			verb: "να έχει"
		},
		file: {
			unit: "bytes",
			verb: "να έχει"
		},
		array: {
			unit: "στοιχεία",
			verb: "να έχει"
		},
		set: {
			unit: "στοιχεία",
			verb: "να έχει"
		},
		map: {
			unit: "καταχωρήσεις",
			verb: "να έχει"
		}
	};
	function n(t) {
		return e[t] ?? null;
	}
	const i = {
		regex: "είσοδος",
		email: "διεύθυνση email",
		url: "URL",
		emoji: "emoji",
		uuid: "UUID",
		uuidv4: "UUIDv4",
		uuidv6: "UUIDv6",
		nanoid: "nanoid",
		guid: "GUID",
		cuid: "cuid",
		cuid2: "cuid2",
		ulid: "ULID",
		xid: "XID",
		ksuid: "KSUID",
		datetime: "ISO ημερομηνία και ώρα",
		date: "ISO ημερομηνία",
		time: "ISO ώρα",
		duration: "ISO διάρκεια",
		ipv4: "διεύθυνση IPv4",
		ipv6: "διεύθυνση IPv6",
		mac: "διεύθυνση MAC",
		cidrv4: "εύρος IPv4",
		cidrv6: "εύρος IPv6",
		base64: "συμβολοσειρά κωδικοποιημένη σε base64",
		base64url: "συμβολοσειρά κωδικοποιημένη σε base64url",
		json_string: "συμβολοσειρά JSON",
		e164: "αριθμός E.164",
		jwt: "JWT",
		template_literal: "είσοδος"
	}, o = { nan: "NaN" };
	return (t) => {
		switch (t.code) {
			case "invalid_type": {
				const r = o[t.expected] ?? t.expected, a = b(t.input), u = o[a] ?? a;
				return typeof t.expected == "string" && /^[A-Z]/.test(t.expected) ? `Μη έγκυρη είσοδος: αναμενόταν instanceof ${t.expected}, λήφθηκε ${u}` : `Μη έγκυρη είσοδος: αναμενόταν ${r}, λήφθηκε ${u}`;
			}
			case "invalid_value": return t.values.length === 1 ? `Μη έγκυρη είσοδος: αναμενόταν ${_(t.values[0])}` : `Μη έγκυρη επιλογή: αναμενόταν ένα από ${v(t.values, "|")}`;
			case "too_big": {
				const r = t.inclusive ? "<=" : "<", a = n(t.origin);
				return a ? `Πολύ μεγάλο: αναμενόταν ${t.origin ?? "τιμή"} να έχει ${r}${t.maximum.toString()} ${a.unit ?? "στοιχεία"}` : `Πολύ μεγάλο: αναμενόταν ${t.origin ?? "τιμή"} να είναι ${r}${t.maximum.toString()}`;
			}
			case "too_small": {
				const r = t.inclusive ? ">=" : ">", a = n(t.origin);
				return a ? `Πολύ μικρό: αναμενόταν ${t.origin} να έχει ${r}${t.minimum.toString()} ${a.unit}` : `Πολύ μικρό: αναμενόταν ${t.origin} να είναι ${r}${t.minimum.toString()}`;
			}
			case "invalid_format": {
				const r = t;
				return r.format === "starts_with" ? `Μη έγκυρη συμβολοσειρά: πρέπει να ξεκινά με "${r.prefix}"` : r.format === "ends_with" ? `Μη έγκυρη συμβολοσειρά: πρέπει να τελειώνει με "${r.suffix}"` : r.format === "includes" ? `Μη έγκυρη συμβολοσειρά: πρέπει να περιέχει "${r.includes}"` : r.format === "regex" ? `Μη έγκυρη συμβολοσειρά: πρέπει να ταιριάζει με το μοτίβο ${r.pattern}` : `Μη έγκυρο: ${i[r.format] ?? t.format}`;
			}
			case "not_multiple_of": return `Μη έγκυρος αριθμός: πρέπει να είναι πολλαπλάσιο του ${t.divisor}`;
			case "unrecognized_keys": return `Άγνωστ${t.keys.length > 1 ? "α" : "ο"} κλειδ${t.keys.length > 1 ? "ιά" : "ί"}: ${v(t.keys, ", ")}`;
			case "invalid_key": return `Μη έγκυρο κλειδί στο ${t.origin}`;
			case "invalid_union": return "Μη έγκυρη είσοδος";
			case "invalid_element": return `Μη έγκυρη τιμή στο ${t.origin}`;
			default: return "Μη έγκυρη είσοδος";
		}
	};
};
function Dm() {
	return { localeError: jm() };
}
const Om = () => {
	const e = {
		string: {
			unit: "characters",
			verb: "to have"
		},
		file: {
			unit: "bytes",
			verb: "to have"
		},
		array: {
			unit: "items",
			verb: "to have"
		},
		set: {
			unit: "items",
			verb: "to have"
		},
		map: {
			unit: "entries",
			verb: "to have"
		}
	};
	function n(t) {
		return e[t] ?? null;
	}
	const i = {
		regex: "input",
		email: "email address",
		url: "URL",
		emoji: "emoji",
		uuid: "UUID",
		uuidv4: "UUIDv4",
		uuidv6: "UUIDv6",
		nanoid: "nanoid",
		guid: "GUID",
		cuid: "cuid",
		cuid2: "cuid2",
		ulid: "ULID",
		xid: "XID",
		ksuid: "KSUID",
		datetime: "ISO datetime",
		date: "ISO date",
		time: "ISO time",
		duration: "ISO duration",
		ipv4: "IPv4 address",
		ipv6: "IPv6 address",
		mac: "MAC address",
		cidrv4: "IPv4 range",
		cidrv6: "IPv6 range",
		base64: "base64-encoded string",
		base64url: "base64url-encoded string",
		json_string: "JSON string",
		e164: "E.164 number",
		jwt: "JWT",
		template_literal: "input"
	}, o = { nan: "NaN" };
	return (t) => {
		switch (t.code) {
			case "invalid_type": {
				const r = o[t.expected] ?? t.expected, a = b(t.input);
				return `Invalid input: expected ${r}, received ${o[a] ?? a}`;
			}
			case "invalid_value": return t.values.length === 1 ? `Invalid input: expected ${_(t.values[0])}` : `Invalid option: expected one of ${v(t.values, "|")}`;
			case "too_big": {
				const r = t.inclusive ? "<=" : "<", a = n(t.origin);
				return a ? `Too big: expected ${t.origin ?? "value"} to have ${r}${t.maximum.toString()} ${a.unit ?? "elements"}` : `Too big: expected ${t.origin ?? "value"} to be ${r}${t.maximum.toString()}`;
			}
			case "too_small": {
				const r = t.inclusive ? ">=" : ">", a = n(t.origin);
				return a ? `Too small: expected ${t.origin} to have ${r}${t.minimum.toString()} ${a.unit}` : `Too small: expected ${t.origin} to be ${r}${t.minimum.toString()}`;
			}
			case "invalid_format": {
				const r = t;
				return r.format === "starts_with" ? `Invalid string: must start with "${r.prefix}"` : r.format === "ends_with" ? `Invalid string: must end with "${r.suffix}"` : r.format === "includes" ? `Invalid string: must include "${r.includes}"` : r.format === "regex" ? `Invalid string: must match pattern ${r.pattern}` : `Invalid ${i[r.format] ?? t.format}`;
			}
			case "not_multiple_of": return `Invalid number: must be a multiple of ${t.divisor}`;
			case "unrecognized_keys": return `Unrecognized key${t.keys.length > 1 ? "s" : ""}: ${v(t.keys, ", ")}`;
			case "invalid_key": return `Invalid key in ${t.origin}`;
			case "invalid_union": return t.options && Array.isArray(t.options) && t.options.length > 0 ? `Invalid discriminator value. Expected ${t.options.map((r) => `'${r}'`).join(" | ")}` : "Invalid input";
			case "invalid_element": return `Invalid value in ${t.origin}`;
			default: return "Invalid input";
		}
	};
};
function Hu() {
	return { localeError: Om() };
}
const Nm = () => {
	const e = {
		string: {
			unit: "karaktrojn",
			verb: "havi"
		},
		file: {
			unit: "bajtojn",
			verb: "havi"
		},
		array: {
			unit: "elementojn",
			verb: "havi"
		},
		set: {
			unit: "elementojn",
			verb: "havi"
		}
	};
	function n(t) {
		return e[t] ?? null;
	}
	const i = {
		regex: "enigo",
		email: "retadreso",
		url: "URL",
		emoji: "emoĝio",
		uuid: "UUID",
		uuidv4: "UUIDv4",
		uuidv6: "UUIDv6",
		nanoid: "nanoid",
		guid: "GUID",
		cuid: "cuid",
		cuid2: "cuid2",
		ulid: "ULID",
		xid: "XID",
		ksuid: "KSUID",
		datetime: "ISO-datotempo",
		date: "ISO-dato",
		time: "ISO-tempo",
		duration: "ISO-daŭro",
		ipv4: "IPv4-adreso",
		ipv6: "IPv6-adreso",
		cidrv4: "IPv4-rango",
		cidrv6: "IPv6-rango",
		base64: "64-ume kodita karaktraro",
		base64url: "URL-64-ume kodita karaktraro",
		json_string: "JSON-karaktraro",
		e164: "E.164-nombro",
		jwt: "JWT",
		template_literal: "enigo"
	}, o = {
		nan: "NaN",
		number: "nombro",
		array: "tabelo",
		null: "senvalora"
	};
	return (t) => {
		switch (t.code) {
			case "invalid_type": {
				const r = o[t.expected] ?? t.expected, a = b(t.input), u = o[a] ?? a;
				return /^[A-Z]/.test(t.expected) ? `Nevalida enigo: atendiĝis instanceof ${t.expected}, riceviĝis ${u}` : `Nevalida enigo: atendiĝis ${r}, riceviĝis ${u}`;
			}
			case "invalid_value": return t.values.length === 1 ? `Nevalida enigo: atendiĝis ${_(t.values[0])}` : `Nevalida opcio: atendiĝis unu el ${v(t.values, "|")}`;
			case "too_big": {
				const r = t.inclusive ? "<=" : "<", a = n(t.origin);
				return a ? `Tro granda: atendiĝis ke ${t.origin ?? "valoro"} havu ${r}${t.maximum.toString()} ${a.unit ?? "elementojn"}` : `Tro granda: atendiĝis ke ${t.origin ?? "valoro"} havu ${r}${t.maximum.toString()}`;
			}
			case "too_small": {
				const r = t.inclusive ? ">=" : ">", a = n(t.origin);
				return a ? `Tro malgranda: atendiĝis ke ${t.origin} havu ${r}${t.minimum.toString()} ${a.unit}` : `Tro malgranda: atendiĝis ke ${t.origin} estu ${r}${t.minimum.toString()}`;
			}
			case "invalid_format": {
				const r = t;
				return r.format === "starts_with" ? `Nevalida karaktraro: devas komenciĝi per "${r.prefix}"` : r.format === "ends_with" ? `Nevalida karaktraro: devas finiĝi per "${r.suffix}"` : r.format === "includes" ? `Nevalida karaktraro: devas inkluzivi "${r.includes}"` : r.format === "regex" ? `Nevalida karaktraro: devas kongrui kun la modelo ${r.pattern}` : `Nevalida ${i[r.format] ?? t.format}`;
			}
			case "not_multiple_of": return `Nevalida nombro: devas esti oblo de ${t.divisor}`;
			case "unrecognized_keys": return `Nekonata${t.keys.length > 1 ? "j" : ""} ŝlosilo${t.keys.length > 1 ? "j" : ""}: ${v(t.keys, ", ")}`;
			case "invalid_key": return `Nevalida ŝlosilo en ${t.origin}`;
			case "invalid_union": return "Nevalida enigo";
			case "invalid_element": return `Nevalida valoro en ${t.origin}`;
			default: return "Nevalida enigo";
		}
	};
};
function Pm() {
	return { localeError: Nm() };
}
const Tm = () => {
	const e = {
		string: {
			unit: "caracteres",
			verb: "tener"
		},
		file: {
			unit: "bytes",
			verb: "tener"
		},
		array: {
			unit: "elementos",
			verb: "tener"
		},
		set: {
			unit: "elementos",
			verb: "tener"
		}
	};
	function n(t) {
		return e[t] ?? null;
	}
	const i = {
		regex: "entrada",
		email: "dirección de correo electrónico",
		url: "URL",
		emoji: "emoji",
		uuid: "UUID",
		uuidv4: "UUIDv4",
		uuidv6: "UUIDv6",
		nanoid: "nanoid",
		guid: "GUID",
		cuid: "cuid",
		cuid2: "cuid2",
		ulid: "ULID",
		xid: "XID",
		ksuid: "KSUID",
		datetime: "fecha y hora ISO",
		date: "fecha ISO",
		time: "hora ISO",
		duration: "duración ISO",
		ipv4: "dirección IPv4",
		ipv6: "dirección IPv6",
		cidrv4: "rango IPv4",
		cidrv6: "rango IPv6",
		base64: "cadena codificada en base64",
		base64url: "URL codificada en base64",
		json_string: "cadena JSON",
		e164: "número E.164",
		jwt: "JWT",
		template_literal: "entrada"
	}, o = {
		nan: "NaN",
		string: "texto",
		number: "número",
		boolean: "booleano",
		array: "arreglo",
		object: "objeto",
		set: "conjunto",
		file: "archivo",
		date: "fecha",
		bigint: "número grande",
		symbol: "símbolo",
		undefined: "indefinido",
		null: "nulo",
		function: "función",
		map: "mapa",
		record: "registro",
		tuple: "tupla",
		enum: "enumeración",
		union: "unión",
		literal: "literal",
		promise: "promesa",
		void: "vacío",
		never: "nunca",
		unknown: "desconocido",
		any: "cualquiera"
	};
	return (t) => {
		switch (t.code) {
			case "invalid_type": {
				const r = o[t.expected] ?? t.expected, a = b(t.input), u = o[a] ?? a;
				return /^[A-Z]/.test(t.expected) ? `Entrada inválida: se esperaba instanceof ${t.expected}, recibido ${u}` : `Entrada inválida: se esperaba ${r}, recibido ${u}`;
			}
			case "invalid_value": return t.values.length === 1 ? `Entrada inválida: se esperaba ${_(t.values[0])}` : `Opción inválida: se esperaba una de ${v(t.values, "|")}`;
			case "too_big": {
				const r = t.inclusive ? "<=" : "<", a = n(t.origin), u = o[t.origin] ?? t.origin;
				return a ? `Demasiado grande: se esperaba que ${u ?? "valor"} tuviera ${r}${t.maximum.toString()} ${a.unit ?? "elementos"}` : `Demasiado grande: se esperaba que ${u ?? "valor"} fuera ${r}${t.maximum.toString()}`;
			}
			case "too_small": {
				const r = t.inclusive ? ">=" : ">", a = n(t.origin), u = o[t.origin] ?? t.origin;
				return a ? `Demasiado pequeño: se esperaba que ${u} tuviera ${r}${t.minimum.toString()} ${a.unit}` : `Demasiado pequeño: se esperaba que ${u} fuera ${r}${t.minimum.toString()}`;
			}
			case "invalid_format": {
				const r = t;
				return r.format === "starts_with" ? `Cadena inválida: debe comenzar con "${r.prefix}"` : r.format === "ends_with" ? `Cadena inválida: debe terminar en "${r.suffix}"` : r.format === "includes" ? `Cadena inválida: debe incluir "${r.includes}"` : r.format === "regex" ? `Cadena inválida: debe coincidir con el patrón ${r.pattern}` : `Inválido ${i[r.format] ?? t.format}`;
			}
			case "not_multiple_of": return `Número inválido: debe ser múltiplo de ${t.divisor}`;
			case "unrecognized_keys": return `Llave${t.keys.length > 1 ? "s" : ""} desconocida${t.keys.length > 1 ? "s" : ""}: ${v(t.keys, ", ")}`;
			case "invalid_key": return `Llave inválida en ${o[t.origin] ?? t.origin}`;
			case "invalid_union": return "Entrada inválida";
			case "invalid_element": return `Valor inválido en ${o[t.origin] ?? t.origin}`;
			default: return "Entrada inválida";
		}
	};
};
function Em() {
	return { localeError: Tm() };
}
const Am = () => {
	const e = {
		string: {
			unit: "کاراکتر",
			verb: "داشته باشد"
		},
		file: {
			unit: "بایت",
			verb: "داشته باشد"
		},
		array: {
			unit: "آیتم",
			verb: "داشته باشد"
		},
		set: {
			unit: "آیتم",
			verb: "داشته باشد"
		}
	};
	function n(t) {
		return e[t] ?? null;
	}
	const i = {
		regex: "ورودی",
		email: "آدرس ایمیل",
		url: "URL",
		emoji: "ایموجی",
		uuid: "UUID",
		uuidv4: "UUIDv4",
		uuidv6: "UUIDv6",
		nanoid: "nanoid",
		guid: "GUID",
		cuid: "cuid",
		cuid2: "cuid2",
		ulid: "ULID",
		xid: "XID",
		ksuid: "KSUID",
		datetime: "تاریخ و زمان ایزو",
		date: "تاریخ ایزو",
		time: "زمان ایزو",
		duration: "مدت زمان ایزو",
		ipv4: "IPv4 آدرس",
		ipv6: "IPv6 آدرس",
		cidrv4: "IPv4 دامنه",
		cidrv6: "IPv6 دامنه",
		base64: "base64-encoded رشته",
		base64url: "base64url-encoded رشته",
		json_string: "JSON رشته",
		e164: "E.164 عدد",
		jwt: "JWT",
		template_literal: "ورودی"
	}, o = {
		nan: "NaN",
		number: "عدد",
		array: "آرایه"
	};
	return (t) => {
		switch (t.code) {
			case "invalid_type": {
				const r = o[t.expected] ?? t.expected, a = b(t.input), u = o[a] ?? a;
				return /^[A-Z]/.test(t.expected) ? `ورودی نامعتبر: می‌بایست instanceof ${t.expected} می‌بود، ${u} دریافت شد` : `ورودی نامعتبر: می‌بایست ${r} می‌بود، ${u} دریافت شد`;
			}
			case "invalid_value": return t.values.length === 1 ? `ورودی نامعتبر: می‌بایست ${_(t.values[0])} می‌بود` : `گزینه نامعتبر: می‌بایست یکی از ${v(t.values, "|")} می‌بود`;
			case "too_big": {
				const r = t.inclusive ? "<=" : "<", a = n(t.origin);
				return a ? `خیلی بزرگ: ${t.origin ?? "مقدار"} باید ${r}${t.maximum.toString()} ${a.unit ?? "عنصر"} باشد` : `خیلی بزرگ: ${t.origin ?? "مقدار"} باید ${r}${t.maximum.toString()} باشد`;
			}
			case "too_small": {
				const r = t.inclusive ? ">=" : ">", a = n(t.origin);
				return a ? `خیلی کوچک: ${t.origin} باید ${r}${t.minimum.toString()} ${a.unit} باشد` : `خیلی کوچک: ${t.origin} باید ${r}${t.minimum.toString()} باشد`;
			}
			case "invalid_format": {
				const r = t;
				return r.format === "starts_with" ? `رشته نامعتبر: باید با "${r.prefix}" شروع شود` : r.format === "ends_with" ? `رشته نامعتبر: باید با "${r.suffix}" تمام شود` : r.format === "includes" ? `رشته نامعتبر: باید شامل "${r.includes}" باشد` : r.format === "regex" ? `رشته نامعتبر: باید با الگوی ${r.pattern} مطابقت داشته باشد` : `${i[r.format] ?? t.format} نامعتبر`;
			}
			case "not_multiple_of": return `عدد نامعتبر: باید مضرب ${t.divisor} باشد`;
			case "unrecognized_keys": return `کلید${t.keys.length > 1 ? "های" : ""} ناشناس: ${v(t.keys, ", ")}`;
			case "invalid_key": return `کلید ناشناس در ${t.origin}`;
			case "invalid_union": return "ورودی نامعتبر";
			case "invalid_element": return `مقدار نامعتبر در ${t.origin}`;
			default: return "ورودی نامعتبر";
		}
	};
};
function Cm() {
	return { localeError: Am() };
}
const Rm = () => {
	const e = {
		string: {
			unit: "merkkiä",
			subject: "merkkijonon"
		},
		file: {
			unit: "tavua",
			subject: "tiedoston"
		},
		array: {
			unit: "alkiota",
			subject: "listan"
		},
		set: {
			unit: "alkiota",
			subject: "joukon"
		},
		number: {
			unit: "",
			subject: "luvun"
		},
		bigint: {
			unit: "",
			subject: "suuren kokonaisluvun"
		},
		int: {
			unit: "",
			subject: "kokonaisluvun"
		},
		date: {
			unit: "",
			subject: "päivämäärän"
		}
	};
	function n(t) {
		return e[t] ?? null;
	}
	const i = {
		regex: "säännöllinen lauseke",
		email: "sähköpostiosoite",
		url: "URL-osoite",
		emoji: "emoji",
		uuid: "UUID",
		uuidv4: "UUIDv4",
		uuidv6: "UUIDv6",
		nanoid: "nanoid",
		guid: "GUID",
		cuid: "cuid",
		cuid2: "cuid2",
		ulid: "ULID",
		xid: "XID",
		ksuid: "KSUID",
		datetime: "ISO-aikaleima",
		date: "ISO-päivämäärä",
		time: "ISO-aika",
		duration: "ISO-kesto",
		ipv4: "IPv4-osoite",
		ipv6: "IPv6-osoite",
		cidrv4: "IPv4-alue",
		cidrv6: "IPv6-alue",
		base64: "base64-koodattu merkkijono",
		base64url: "base64url-koodattu merkkijono",
		json_string: "JSON-merkkijono",
		e164: "E.164-luku",
		jwt: "JWT",
		template_literal: "templaattimerkkijono"
	}, o = { nan: "NaN" };
	return (t) => {
		switch (t.code) {
			case "invalid_type": {
				const r = o[t.expected] ?? t.expected, a = b(t.input), u = o[a] ?? a;
				return /^[A-Z]/.test(t.expected) ? `Virheellinen tyyppi: odotettiin instanceof ${t.expected}, oli ${u}` : `Virheellinen tyyppi: odotettiin ${r}, oli ${u}`;
			}
			case "invalid_value": return t.values.length === 1 ? `Virheellinen syöte: täytyy olla ${_(t.values[0])}` : `Virheellinen valinta: täytyy olla yksi seuraavista: ${v(t.values, "|")}`;
			case "too_big": {
				const r = t.inclusive ? "<=" : "<", a = n(t.origin);
				return a ? `Liian suuri: ${a.subject} täytyy olla ${r}${t.maximum.toString()} ${a.unit}`.trim() : `Liian suuri: arvon täytyy olla ${r}${t.maximum.toString()}`;
			}
			case "too_small": {
				const r = t.inclusive ? ">=" : ">", a = n(t.origin);
				return a ? `Liian pieni: ${a.subject} täytyy olla ${r}${t.minimum.toString()} ${a.unit}`.trim() : `Liian pieni: arvon täytyy olla ${r}${t.minimum.toString()}`;
			}
			case "invalid_format": {
				const r = t;
				return r.format === "starts_with" ? `Virheellinen syöte: täytyy alkaa "${r.prefix}"` : r.format === "ends_with" ? `Virheellinen syöte: täytyy loppua "${r.suffix}"` : r.format === "includes" ? `Virheellinen syöte: täytyy sisältää "${r.includes}"` : r.format === "regex" ? `Virheellinen syöte: täytyy vastata säännöllistä lauseketta ${r.pattern}` : `Virheellinen ${i[r.format] ?? t.format}`;
			}
			case "not_multiple_of": return `Virheellinen luku: täytyy olla luvun ${t.divisor} monikerta`;
			case "unrecognized_keys": return `${t.keys.length > 1 ? "Tuntemattomat avaimet" : "Tuntematon avain"}: ${v(t.keys, ", ")}`;
			case "invalid_key": return "Virheellinen avain tietueessa";
			case "invalid_union": return "Virheellinen unioni";
			case "invalid_element": return "Virheellinen arvo joukossa";
			default: return "Virheellinen syöte";
		}
	};
};
function Lm() {
	return { localeError: Rm() };
}
const Fm = () => {
	const e = {
		string: {
			unit: "caractères",
			verb: "avoir"
		},
		file: {
			unit: "octets",
			verb: "avoir"
		},
		array: {
			unit: "éléments",
			verb: "avoir"
		},
		set: {
			unit: "éléments",
			verb: "avoir"
		}
	};
	function n(t) {
		return e[t] ?? null;
	}
	const i = {
		regex: "entrée",
		email: "adresse e-mail",
		url: "URL",
		emoji: "emoji",
		uuid: "UUID",
		uuidv4: "UUIDv4",
		uuidv6: "UUIDv6",
		nanoid: "nanoid",
		guid: "GUID",
		cuid: "cuid",
		cuid2: "cuid2",
		ulid: "ULID",
		xid: "XID",
		ksuid: "KSUID",
		datetime: "date et heure ISO",
		date: "date ISO",
		time: "heure ISO",
		duration: "durée ISO",
		ipv4: "adresse IPv4",
		ipv6: "adresse IPv6",
		cidrv4: "plage IPv4",
		cidrv6: "plage IPv6",
		base64: "chaîne encodée en base64",
		base64url: "chaîne encodée en base64url",
		json_string: "chaîne JSON",
		e164: "numéro E.164",
		jwt: "JWT",
		template_literal: "entrée"
	}, o = {
		string: "chaîne",
		number: "nombre",
		int: "entier",
		boolean: "booléen",
		bigint: "grand entier",
		symbol: "symbole",
		undefined: "indéfini",
		null: "null",
		never: "jamais",
		void: "vide",
		date: "date",
		array: "tableau",
		object: "objet",
		tuple: "tuple",
		record: "enregistrement",
		map: "carte",
		set: "ensemble",
		file: "fichier",
		nonoptional: "non-optionnel",
		nan: "NaN",
		function: "fonction"
	};
	return (t) => {
		switch (t.code) {
			case "invalid_type": {
				const r = o[t.expected] ?? t.expected, a = b(t.input), u = o[a] ?? a;
				return /^[A-Z]/.test(t.expected) ? `Entrée invalide : instanceof ${t.expected} attendu, ${u} reçu` : `Entrée invalide : ${r} attendu, ${u} reçu`;
			}
			case "invalid_value": return t.values.length === 1 ? `Entrée invalide : ${_(t.values[0])} attendu` : `Option invalide : une valeur parmi ${v(t.values, "|")} attendue`;
			case "too_big": {
				const r = t.inclusive ? "<=" : "<", a = n(t.origin);
				return a ? `Trop grand : ${o[t.origin] ?? "valeur"} doit ${a.verb} ${r}${t.maximum.toString()} ${a.unit ?? "élément(s)"}` : `Trop grand : ${o[t.origin] ?? "valeur"} doit être ${r}${t.maximum.toString()}`;
			}
			case "too_small": {
				const r = t.inclusive ? ">=" : ">", a = n(t.origin);
				return a ? `Trop petit : ${o[t.origin] ?? "valeur"} doit ${a.verb} ${r}${t.minimum.toString()} ${a.unit}` : `Trop petit : ${o[t.origin] ?? "valeur"} doit être ${r}${t.minimum.toString()}`;
			}
			case "invalid_format": {
				const r = t;
				return r.format === "starts_with" ? `Chaîne invalide : doit commencer par "${r.prefix}"` : r.format === "ends_with" ? `Chaîne invalide : doit se terminer par "${r.suffix}"` : r.format === "includes" ? `Chaîne invalide : doit inclure "${r.includes}"` : r.format === "regex" ? `Chaîne invalide : doit correspondre au modèle ${r.pattern}` : `${i[r.format] ?? t.format} invalide`;
			}
			case "not_multiple_of": return `Nombre invalide : doit être un multiple de ${t.divisor}`;
			case "unrecognized_keys": return `Clé${t.keys.length > 1 ? "s" : ""} non reconnue${t.keys.length > 1 ? "s" : ""} : ${v(t.keys, ", ")}`;
			case "invalid_key": return `Clé invalide dans ${t.origin}`;
			case "invalid_union": return "Entrée invalide";
			case "invalid_element": return `Valeur invalide dans ${t.origin}`;
			default: return "Entrée invalide";
		}
	};
};
function Jm() {
	return { localeError: Fm() };
}
const Mm = () => {
	const e = {
		string: {
			unit: "caractères",
			verb: "avoir"
		},
		file: {
			unit: "octets",
			verb: "avoir"
		},
		array: {
			unit: "éléments",
			verb: "avoir"
		},
		set: {
			unit: "éléments",
			verb: "avoir"
		}
	};
	function n(t) {
		return e[t] ?? null;
	}
	const i = {
		regex: "entrée",
		email: "adresse courriel",
		url: "URL",
		emoji: "emoji",
		uuid: "UUID",
		uuidv4: "UUIDv4",
		uuidv6: "UUIDv6",
		nanoid: "nanoid",
		guid: "GUID",
		cuid: "cuid",
		cuid2: "cuid2",
		ulid: "ULID",
		xid: "XID",
		ksuid: "KSUID",
		datetime: "date-heure ISO",
		date: "date ISO",
		time: "heure ISO",
		duration: "durée ISO",
		ipv4: "adresse IPv4",
		ipv6: "adresse IPv6",
		cidrv4: "plage IPv4",
		cidrv6: "plage IPv6",
		base64: "chaîne encodée en base64",
		base64url: "chaîne encodée en base64url",
		json_string: "chaîne JSON",
		e164: "numéro E.164",
		jwt: "JWT",
		template_literal: "entrée"
	}, o = { nan: "NaN" };
	return (t) => {
		switch (t.code) {
			case "invalid_type": {
				const r = o[t.expected] ?? t.expected, a = b(t.input), u = o[a] ?? a;
				return /^[A-Z]/.test(t.expected) ? `Entrée invalide : attendu instanceof ${t.expected}, reçu ${u}` : `Entrée invalide : attendu ${r}, reçu ${u}`;
			}
			case "invalid_value": return t.values.length === 1 ? `Entrée invalide : attendu ${_(t.values[0])}` : `Option invalide : attendu l'une des valeurs suivantes ${v(t.values, "|")}`;
			case "too_big": {
				const r = t.inclusive ? "≤" : "<", a = n(t.origin);
				return a ? `Trop grand : attendu que ${t.origin ?? "la valeur"} ait ${r}${t.maximum.toString()} ${a.unit}` : `Trop grand : attendu que ${t.origin ?? "la valeur"} soit ${r}${t.maximum.toString()}`;
			}
			case "too_small": {
				const r = t.inclusive ? "≥" : ">", a = n(t.origin);
				return a ? `Trop petit : attendu que ${t.origin} ait ${r}${t.minimum.toString()} ${a.unit}` : `Trop petit : attendu que ${t.origin} soit ${r}${t.minimum.toString()}`;
			}
			case "invalid_format": {
				const r = t;
				return r.format === "starts_with" ? `Chaîne invalide : doit commencer par "${r.prefix}"` : r.format === "ends_with" ? `Chaîne invalide : doit se terminer par "${r.suffix}"` : r.format === "includes" ? `Chaîne invalide : doit inclure "${r.includes}"` : r.format === "regex" ? `Chaîne invalide : doit correspondre au motif ${r.pattern}` : `${i[r.format] ?? t.format} invalide`;
			}
			case "not_multiple_of": return `Nombre invalide : doit être un multiple de ${t.divisor}`;
			case "unrecognized_keys": return `Clé${t.keys.length > 1 ? "s" : ""} non reconnue${t.keys.length > 1 ? "s" : ""} : ${v(t.keys, ", ")}`;
			case "invalid_key": return `Clé invalide dans ${t.origin}`;
			case "invalid_union": return "Entrée invalide";
			case "invalid_element": return `Valeur invalide dans ${t.origin}`;
			default: return "Entrée invalide";
		}
	};
};
function Km() {
	return { localeError: Mm() };
}
const Gm = () => {
	const e = {
		string: {
			label: "מחרוזת",
			gender: "f"
		},
		number: {
			label: "מספר",
			gender: "m"
		},
		boolean: {
			label: "ערך בוליאני",
			gender: "m"
		},
		bigint: {
			label: "BigInt",
			gender: "m"
		},
		date: {
			label: "תאריך",
			gender: "m"
		},
		array: {
			label: "מערך",
			gender: "m"
		},
		object: {
			label: "אובייקט",
			gender: "m"
		},
		null: {
			label: "ערך ריק (null)",
			gender: "m"
		},
		undefined: {
			label: "ערך לא מוגדר (undefined)",
			gender: "m"
		},
		symbol: {
			label: "סימבול (Symbol)",
			gender: "m"
		},
		function: {
			label: "פונקציה",
			gender: "f"
		},
		map: {
			label: "מפה (Map)",
			gender: "f"
		},
		set: {
			label: "קבוצה (Set)",
			gender: "f"
		},
		file: {
			label: "קובץ",
			gender: "m"
		},
		promise: {
			label: "Promise",
			gender: "m"
		},
		NaN: {
			label: "NaN",
			gender: "m"
		},
		unknown: {
			label: "ערך לא ידוע",
			gender: "m"
		},
		value: {
			label: "ערך",
			gender: "m"
		}
	}, n = {
		string: {
			unit: "תווים",
			shortLabel: "קצר",
			longLabel: "ארוך"
		},
		file: {
			unit: "בייטים",
			shortLabel: "קטן",
			longLabel: "גדול"
		},
		array: {
			unit: "פריטים",
			shortLabel: "קטן",
			longLabel: "גדול"
		},
		set: {
			unit: "פריטים",
			shortLabel: "קטן",
			longLabel: "גדול"
		},
		number: {
			unit: "",
			shortLabel: "קטן",
			longLabel: "גדול"
		}
	}, i = (c) => c ? e[c] : void 0, o = (c) => {
		const s = i(c);
		return s ? s.label : c ?? e.unknown.label;
	}, t = (c) => `ה${o(c)}`, r = (c) => (i(c)?.gender ?? "m") === "f" ? "צריכה להיות" : "צריך להיות", a = (c) => c ? n[c] ?? null : null, u = {
		regex: {
			label: "קלט",
			gender: "m"
		},
		email: {
			label: "כתובת אימייל",
			gender: "f"
		},
		url: {
			label: "כתובת רשת",
			gender: "f"
		},
		emoji: {
			label: "אימוג'י",
			gender: "m"
		},
		uuid: {
			label: "UUID",
			gender: "m"
		},
		nanoid: {
			label: "nanoid",
			gender: "m"
		},
		guid: {
			label: "GUID",
			gender: "m"
		},
		cuid: {
			label: "cuid",
			gender: "m"
		},
		cuid2: {
			label: "cuid2",
			gender: "m"
		},
		ulid: {
			label: "ULID",
			gender: "m"
		},
		xid: {
			label: "XID",
			gender: "m"
		},
		ksuid: {
			label: "KSUID",
			gender: "m"
		},
		datetime: {
			label: "תאריך וזמן ISO",
			gender: "m"
		},
		date: {
			label: "תאריך ISO",
			gender: "m"
		},
		time: {
			label: "זמן ISO",
			gender: "m"
		},
		duration: {
			label: "משך זמן ISO",
			gender: "m"
		},
		ipv4: {
			label: "כתובת IPv4",
			gender: "f"
		},
		ipv6: {
			label: "כתובת IPv6",
			gender: "f"
		},
		cidrv4: {
			label: "טווח IPv4",
			gender: "m"
		},
		cidrv6: {
			label: "טווח IPv6",
			gender: "m"
		},
		base64: {
			label: "מחרוזת בבסיס 64",
			gender: "f"
		},
		base64url: {
			label: "מחרוזת בבסיס 64 לכתובות רשת",
			gender: "f"
		},
		json_string: {
			label: "מחרוזת JSON",
			gender: "f"
		},
		e164: {
			label: "מספר E.164",
			gender: "m"
		},
		jwt: {
			label: "JWT",
			gender: "m"
		},
		ends_with: {
			label: "קלט",
			gender: "m"
		},
		includes: {
			label: "קלט",
			gender: "m"
		},
		lowercase: {
			label: "קלט",
			gender: "m"
		},
		starts_with: {
			label: "קלט",
			gender: "m"
		},
		uppercase: {
			label: "קלט",
			gender: "m"
		}
	}, l = { nan: "NaN" };
	return (c) => {
		switch (c.code) {
			case "invalid_type": {
				const s = c.expected, f = l[s ?? ""] ?? o(s), m = b(c.input), g = l[m] ?? e[m]?.label ?? m;
				return /^[A-Z]/.test(c.expected) ? `קלט לא תקין: צריך להיות instanceof ${c.expected}, התקבל ${g}` : `קלט לא תקין: צריך להיות ${f}, התקבל ${g}`;
			}
			case "invalid_value": {
				if (c.values.length === 1) return `ערך לא תקין: הערך חייב להיות ${_(c.values[0])}`;
				const s = c.values.map((m) => _(m));
				if (c.values.length === 2) return `ערך לא תקין: האפשרויות המתאימות הן ${s[0]} או ${s[1]}`;
				const f = s[s.length - 1];
				return `ערך לא תקין: האפשרויות המתאימות הן ${s.slice(0, -1).join(", ")} או ${f}`;
			}
			case "too_big": {
				const s = a(c.origin), f = t(c.origin ?? "value");
				if (c.origin === "string") return `${s?.longLabel ?? "ארוך"} מדי: ${f} צריכה להכיל ${c.maximum.toString()} ${s?.unit ?? ""} ${c.inclusive ? "או פחות" : "לכל היותר"}`.trim();
				if (c.origin === "number") return `גדול מדי: ${f} צריך להיות ${c.inclusive ? `קטן או שווה ל-${c.maximum}` : `קטן מ-${c.maximum}`}`;
				if (c.origin === "array" || c.origin === "set") return `גדול מדי: ${f} ${c.origin === "set" ? "צריכה" : "צריך"} להכיל ${c.inclusive ? `${c.maximum} ${s?.unit ?? ""} או פחות` : `פחות מ-${c.maximum} ${s?.unit ?? ""}`}`.trim();
				const m = c.inclusive ? "<=" : "<", g = r(c.origin ?? "value");
				return s?.unit ? `${s.longLabel} מדי: ${f} ${g} ${m}${c.maximum.toString()} ${s.unit}` : `${s?.longLabel ?? "גדול"} מדי: ${f} ${g} ${m}${c.maximum.toString()}`;
			}
			case "too_small": {
				const s = a(c.origin), f = t(c.origin ?? "value");
				if (c.origin === "string") return `${s?.shortLabel ?? "קצר"} מדי: ${f} צריכה להכיל ${c.minimum.toString()} ${s?.unit ?? ""} ${c.inclusive ? "או יותר" : "לפחות"}`.trim();
				if (c.origin === "number") return `קטן מדי: ${f} צריך להיות ${c.inclusive ? `גדול או שווה ל-${c.minimum}` : `גדול מ-${c.minimum}`}`;
				if (c.origin === "array" || c.origin === "set") {
					const I = c.origin === "set" ? "צריכה" : "צריך";
					return c.minimum === 1 && c.inclusive ? `קטן מדי: ${f} ${I} להכיל ${c.origin, "לפחות פריט אחד"}` : `קטן מדי: ${f} ${I} להכיל ${c.inclusive ? `${c.minimum} ${s?.unit ?? ""} או יותר` : `יותר מ-${c.minimum} ${s?.unit ?? ""}`}`.trim();
				}
				const m = c.inclusive ? ">=" : ">", g = r(c.origin ?? "value");
				return s?.unit ? `${s.shortLabel} מדי: ${f} ${g} ${m}${c.minimum.toString()} ${s.unit}` : `${s?.shortLabel ?? "קטן"} מדי: ${f} ${g} ${m}${c.minimum.toString()}`;
			}
			case "invalid_format": {
				const s = c;
				if (s.format === "starts_with") return `המחרוזת חייבת להתחיל ב "${s.prefix}"`;
				if (s.format === "ends_with") return `המחרוזת חייבת להסתיים ב "${s.suffix}"`;
				if (s.format === "includes") return `המחרוזת חייבת לכלול "${s.includes}"`;
				if (s.format === "regex") return `המחרוזת חייבת להתאים לתבנית ${s.pattern}`;
				const f = u[s.format];
				return `${f?.label ?? s.format} לא ${(f?.gender ?? "m") === "f" ? "תקינה" : "תקין"}`;
			}
			case "not_multiple_of": return `מספר לא תקין: חייב להיות מכפלה של ${c.divisor}`;
			case "unrecognized_keys": return `מפתח${c.keys.length > 1 ? "ות" : ""} לא מזוה${c.keys.length > 1 ? "ים" : "ה"}: ${v(c.keys, ", ")}`;
			case "invalid_key": return "שדה לא תקין באובייקט";
			case "invalid_union": return "קלט לא תקין";
			case "invalid_element": return `ערך לא תקין ב${t(c.origin ?? "array")}`;
			default: return "קלט לא תקין";
		}
	};
};
function Vm() {
	return { localeError: Gm() };
}
const Bm = () => {
	const e = {
		string: {
			unit: "znakova",
			verb: "imati"
		},
		file: {
			unit: "bajtova",
			verb: "imati"
		},
		array: {
			unit: "stavki",
			verb: "imati"
		},
		set: {
			unit: "stavki",
			verb: "imati"
		}
	};
	function n(t) {
		return e[t] ?? null;
	}
	const i = {
		regex: "unos",
		email: "email adresa",
		url: "URL",
		emoji: "emoji",
		uuid: "UUID",
		uuidv4: "UUIDv4",
		uuidv6: "UUIDv6",
		nanoid: "nanoid",
		guid: "GUID",
		cuid: "cuid",
		cuid2: "cuid2",
		ulid: "ULID",
		xid: "XID",
		ksuid: "KSUID",
		datetime: "ISO datum i vrijeme",
		date: "ISO datum",
		time: "ISO vrijeme",
		duration: "ISO trajanje",
		ipv4: "IPv4 adresa",
		ipv6: "IPv6 adresa",
		cidrv4: "IPv4 raspon",
		cidrv6: "IPv6 raspon",
		base64: "base64 kodirani tekst",
		base64url: "base64url kodirani tekst",
		json_string: "JSON tekst",
		e164: "E.164 broj",
		jwt: "JWT",
		template_literal: "unos"
	}, o = {
		nan: "NaN",
		string: "tekst",
		number: "broj",
		boolean: "boolean",
		array: "niz",
		object: "objekt",
		set: "skup",
		file: "datoteka",
		date: "datum",
		bigint: "bigint",
		symbol: "simbol",
		undefined: "undefined",
		null: "null",
		function: "funkcija",
		map: "mapa"
	};
	return (t) => {
		switch (t.code) {
			case "invalid_type": {
				const r = o[t.expected] ?? t.expected, a = b(t.input), u = o[a] ?? a;
				return /^[A-Z]/.test(t.expected) ? `Neispravan unos: očekuje se instanceof ${t.expected}, a primljeno je ${u}` : `Neispravan unos: očekuje se ${r}, a primljeno je ${u}`;
			}
			case "invalid_value": return t.values.length === 1 ? `Neispravna vrijednost: očekivano ${_(t.values[0])}` : `Neispravna opcija: očekivano jedno od ${v(t.values, "|")}`;
			case "too_big": {
				const r = t.inclusive ? "<=" : "<", a = n(t.origin), u = o[t.origin] ?? t.origin;
				return a ? `Preveliko: očekivano da ${u ?? "vrijednost"} ima ${r}${t.maximum.toString()} ${a.unit ?? "elemenata"}` : `Preveliko: očekivano da ${u ?? "vrijednost"} bude ${r}${t.maximum.toString()}`;
			}
			case "too_small": {
				const r = t.inclusive ? ">=" : ">", a = n(t.origin), u = o[t.origin] ?? t.origin;
				return a ? `Premalo: očekivano da ${u} ima ${r}${t.minimum.toString()} ${a.unit}` : `Premalo: očekivano da ${u} bude ${r}${t.minimum.toString()}`;
			}
			case "invalid_format": {
				const r = t;
				return r.format === "starts_with" ? `Neispravan tekst: mora započinjati s "${r.prefix}"` : r.format === "ends_with" ? `Neispravan tekst: mora završavati s "${r.suffix}"` : r.format === "includes" ? `Neispravan tekst: mora sadržavati "${r.includes}"` : r.format === "regex" ? `Neispravan tekst: mora odgovarati uzorku ${r.pattern}` : `Neispravna ${i[r.format] ?? t.format}`;
			}
			case "not_multiple_of": return `Neispravan broj: mora biti višekratnik od ${t.divisor}`;
			case "unrecognized_keys": return `Neprepoznat${t.keys.length > 1 ? "i ključevi" : " ključ"}: ${v(t.keys, ", ")}`;
			case "invalid_key": return `Neispravan ključ u ${o[t.origin] ?? t.origin}`;
			case "invalid_union": return "Neispravan unos";
			case "invalid_element": return `Neispravna vrijednost u ${o[t.origin] ?? t.origin}`;
			default: return "Neispravan unos";
		}
	};
};
function Wm() {
	return { localeError: Bm() };
}
const Xm = () => {
	const e = {
		string: {
			unit: "karakter",
			verb: "legyen"
		},
		file: {
			unit: "byte",
			verb: "legyen"
		},
		array: {
			unit: "elem",
			verb: "legyen"
		},
		set: {
			unit: "elem",
			verb: "legyen"
		}
	};
	function n(t) {
		return e[t] ?? null;
	}
	const i = {
		regex: "bemenet",
		email: "email cím",
		url: "URL",
		emoji: "emoji",
		uuid: "UUID",
		uuidv4: "UUIDv4",
		uuidv6: "UUIDv6",
		nanoid: "nanoid",
		guid: "GUID",
		cuid: "cuid",
		cuid2: "cuid2",
		ulid: "ULID",
		xid: "XID",
		ksuid: "KSUID",
		datetime: "ISO időbélyeg",
		date: "ISO dátum",
		time: "ISO idő",
		duration: "ISO időintervallum",
		ipv4: "IPv4 cím",
		ipv6: "IPv6 cím",
		cidrv4: "IPv4 tartomány",
		cidrv6: "IPv6 tartomány",
		base64: "base64-kódolt string",
		base64url: "base64url-kódolt string",
		json_string: "JSON string",
		e164: "E.164 szám",
		jwt: "JWT",
		template_literal: "bemenet"
	}, o = {
		nan: "NaN",
		number: "szám",
		array: "tömb"
	};
	return (t) => {
		switch (t.code) {
			case "invalid_type": {
				const r = o[t.expected] ?? t.expected, a = b(t.input), u = o[a] ?? a;
				return /^[A-Z]/.test(t.expected) ? `Érvénytelen bemenet: a várt érték instanceof ${t.expected}, a kapott érték ${u}` : `Érvénytelen bemenet: a várt érték ${r}, a kapott érték ${u}`;
			}
			case "invalid_value": return t.values.length === 1 ? `Érvénytelen bemenet: a várt érték ${_(t.values[0])}` : `Érvénytelen opció: valamelyik érték várt ${v(t.values, "|")}`;
			case "too_big": {
				const r = t.inclusive ? "<=" : "<", a = n(t.origin);
				return a ? `Túl nagy: ${t.origin ?? "érték"} mérete túl nagy ${r}${t.maximum.toString()} ${a.unit ?? "elem"}` : `Túl nagy: a bemeneti érték ${t.origin ?? "érték"} túl nagy: ${r}${t.maximum.toString()}`;
			}
			case "too_small": {
				const r = t.inclusive ? ">=" : ">", a = n(t.origin);
				return a ? `Túl kicsi: a bemeneti érték ${t.origin} mérete túl kicsi ${r}${t.minimum.toString()} ${a.unit}` : `Túl kicsi: a bemeneti érték ${t.origin} túl kicsi ${r}${t.minimum.toString()}`;
			}
			case "invalid_format": {
				const r = t;
				return r.format === "starts_with" ? `Érvénytelen string: "${r.prefix}" értékkel kell kezdődnie` : r.format === "ends_with" ? `Érvénytelen string: "${r.suffix}" értékkel kell végződnie` : r.format === "includes" ? `Érvénytelen string: "${r.includes}" értéket kell tartalmaznia` : r.format === "regex" ? `Érvénytelen string: ${r.pattern} mintának kell megfelelnie` : `Érvénytelen ${i[r.format] ?? t.format}`;
			}
			case "not_multiple_of": return `Érvénytelen szám: ${t.divisor} többszörösének kell lennie`;
			case "unrecognized_keys": return `Ismeretlen kulcs${t.keys.length > 1 ? "s" : ""}: ${v(t.keys, ", ")}`;
			case "invalid_key": return `Érvénytelen kulcs ${t.origin}`;
			case "invalid_union": return "Érvénytelen bemenet";
			case "invalid_element": return `Érvénytelen érték: ${t.origin}`;
			default: return "Érvénytelen bemenet";
		}
	};
};
function qm() {
	return { localeError: Xm() };
}
function Yi(e, n, i) {
	return Math.abs(e) === 1 ? n : i;
}
function _e(e) {
	if (!e) return "";
	const n = [
		"ա",
		"ե",
		"ը",
		"ի",
		"ո",
		"ու",
		"օ"
	], i = e[e.length - 1];
	return e + (n.includes(i) ? "ն" : "ը");
}
const Ym = () => {
	const e = {
		string: {
			unit: {
				one: "նշան",
				many: "նշաններ"
			},
			verb: "ունենալ"
		},
		file: {
			unit: {
				one: "բայթ",
				many: "բայթեր"
			},
			verb: "ունենալ"
		},
		array: {
			unit: {
				one: "տարր",
				many: "տարրեր"
			},
			verb: "ունենալ"
		},
		set: {
			unit: {
				one: "տարր",
				many: "տարրեր"
			},
			verb: "ունենալ"
		}
	};
	function n(t) {
		return e[t] ?? null;
	}
	const i = {
		regex: "մուտք",
		email: "էլ. հասցե",
		url: "URL",
		emoji: "էմոջի",
		uuid: "UUID",
		uuidv4: "UUIDv4",
		uuidv6: "UUIDv6",
		nanoid: "nanoid",
		guid: "GUID",
		cuid: "cuid",
		cuid2: "cuid2",
		ulid: "ULID",
		xid: "XID",
		ksuid: "KSUID",
		datetime: "ISO ամսաթիվ և ժամ",
		date: "ISO ամսաթիվ",
		time: "ISO ժամ",
		duration: "ISO տևողություն",
		ipv4: "IPv4 հասցե",
		ipv6: "IPv6 հասցե",
		cidrv4: "IPv4 միջակայք",
		cidrv6: "IPv6 միջակայք",
		base64: "base64 ձևաչափով տող",
		base64url: "base64url ձևաչափով տող",
		json_string: "JSON տող",
		e164: "E.164 համար",
		jwt: "JWT",
		template_literal: "մուտք"
	}, o = {
		nan: "NaN",
		number: "թիվ",
		array: "զանգված"
	};
	return (t) => {
		switch (t.code) {
			case "invalid_type": {
				const r = o[t.expected] ?? t.expected, a = b(t.input), u = o[a] ?? a;
				return /^[A-Z]/.test(t.expected) ? `Սխալ մուտքագրում․ սպասվում էր instanceof ${t.expected}, ստացվել է ${u}` : `Սխալ մուտքագրում․ սպասվում էր ${r}, ստացվել է ${u}`;
			}
			case "invalid_value": return t.values.length === 1 ? `Սխալ մուտքագրում․ սպասվում էր ${_(t.values[1])}` : `Սխալ տարբերակ․ սպասվում էր հետևյալներից մեկը՝ ${v(t.values, "|")}`;
			case "too_big": {
				const r = t.inclusive ? "<=" : "<", a = n(t.origin);
				if (a) {
					const u = Yi(Number(t.maximum), a.unit.one, a.unit.many);
					return `Չափազանց մեծ արժեք․ սպասվում է, որ ${_e(t.origin ?? "արժեք")} կունենա ${r}${t.maximum.toString()} ${u}`;
				}
				return `Չափազանց մեծ արժեք․ սպասվում է, որ ${_e(t.origin ?? "արժեք")} լինի ${r}${t.maximum.toString()}`;
			}
			case "too_small": {
				const r = t.inclusive ? ">=" : ">", a = n(t.origin);
				if (a) {
					const u = Yi(Number(t.minimum), a.unit.one, a.unit.many);
					return `Չափազանց փոքր արժեք․ սպասվում է, որ ${_e(t.origin)} կունենա ${r}${t.minimum.toString()} ${u}`;
				}
				return `Չափազանց փոքր արժեք․ սպասվում է, որ ${_e(t.origin)} լինի ${r}${t.minimum.toString()}`;
			}
			case "invalid_format": {
				const r = t;
				return r.format === "starts_with" ? `Սխալ տող․ պետք է սկսվի "${r.prefix}"-ով` : r.format === "ends_with" ? `Սխալ տող․ պետք է ավարտվի "${r.suffix}"-ով` : r.format === "includes" ? `Սխալ տող․ պետք է պարունակի "${r.includes}"` : r.format === "regex" ? `Սխալ տող․ պետք է համապատասխանի ${r.pattern} ձևաչափին` : `Սխալ ${i[r.format] ?? t.format}`;
			}
			case "not_multiple_of": return `Սխալ թիվ․ պետք է բազմապատիկ լինի ${t.divisor}-ի`;
			case "unrecognized_keys": return `Չճանաչված բանալի${t.keys.length > 1 ? "ներ" : ""}. ${v(t.keys, ", ")}`;
			case "invalid_key": return `Սխալ բանալի ${_e(t.origin)}-ում`;
			case "invalid_union": return "Սխալ մուտքագրում";
			case "invalid_element": return `Սխալ արժեք ${_e(t.origin)}-ում`;
			default: return "Սխալ մուտքագրում";
		}
	};
};
function Hm() {
	return { localeError: Ym() };
}
const Qm = () => {
	const e = {
		string: {
			unit: "karakter",
			verb: "memiliki"
		},
		file: {
			unit: "byte",
			verb: "memiliki"
		},
		array: {
			unit: "item",
			verb: "memiliki"
		},
		set: {
			unit: "item",
			verb: "memiliki"
		}
	};
	function n(t) {
		return e[t] ?? null;
	}
	const i = {
		regex: "input",
		email: "alamat email",
		url: "URL",
		emoji: "emoji",
		uuid: "UUID",
		uuidv4: "UUIDv4",
		uuidv6: "UUIDv6",
		nanoid: "nanoid",
		guid: "GUID",
		cuid: "cuid",
		cuid2: "cuid2",
		ulid: "ULID",
		xid: "XID",
		ksuid: "KSUID",
		datetime: "tanggal dan waktu format ISO",
		date: "tanggal format ISO",
		time: "jam format ISO",
		duration: "durasi format ISO",
		ipv4: "alamat IPv4",
		ipv6: "alamat IPv6",
		cidrv4: "rentang alamat IPv4",
		cidrv6: "rentang alamat IPv6",
		base64: "string dengan enkode base64",
		base64url: "string dengan enkode base64url",
		json_string: "string JSON",
		e164: "angka E.164",
		jwt: "JWT",
		template_literal: "input"
	}, o = { nan: "NaN" };
	return (t) => {
		switch (t.code) {
			case "invalid_type": {
				const r = o[t.expected] ?? t.expected, a = b(t.input), u = o[a] ?? a;
				return /^[A-Z]/.test(t.expected) ? `Input tidak valid: diharapkan instanceof ${t.expected}, diterima ${u}` : `Input tidak valid: diharapkan ${r}, diterima ${u}`;
			}
			case "invalid_value": return t.values.length === 1 ? `Input tidak valid: diharapkan ${_(t.values[0])}` : `Pilihan tidak valid: diharapkan salah satu dari ${v(t.values, "|")}`;
			case "too_big": {
				const r = t.inclusive ? "<=" : "<", a = n(t.origin);
				return a ? `Terlalu besar: diharapkan ${t.origin ?? "value"} memiliki ${r}${t.maximum.toString()} ${a.unit ?? "elemen"}` : `Terlalu besar: diharapkan ${t.origin ?? "value"} menjadi ${r}${t.maximum.toString()}`;
			}
			case "too_small": {
				const r = t.inclusive ? ">=" : ">", a = n(t.origin);
				return a ? `Terlalu kecil: diharapkan ${t.origin} memiliki ${r}${t.minimum.toString()} ${a.unit}` : `Terlalu kecil: diharapkan ${t.origin} menjadi ${r}${t.minimum.toString()}`;
			}
			case "invalid_format": {
				const r = t;
				return r.format === "starts_with" ? `String tidak valid: harus dimulai dengan "${r.prefix}"` : r.format === "ends_with" ? `String tidak valid: harus berakhir dengan "${r.suffix}"` : r.format === "includes" ? `String tidak valid: harus menyertakan "${r.includes}"` : r.format === "regex" ? `String tidak valid: harus sesuai pola ${r.pattern}` : `${i[r.format] ?? t.format} tidak valid`;
			}
			case "not_multiple_of": return `Angka tidak valid: harus kelipatan dari ${t.divisor}`;
			case "unrecognized_keys": return `Kunci tidak dikenali ${t.keys.length > 1 ? "s" : ""}: ${v(t.keys, ", ")}`;
			case "invalid_key": return `Kunci tidak valid di ${t.origin}`;
			case "invalid_union": return "Input tidak valid";
			case "invalid_element": return `Nilai tidak valid di ${t.origin}`;
			default: return "Input tidak valid";
		}
	};
};
function ef() {
	return { localeError: Qm() };
}
const tf = () => {
	const e = {
		string: {
			unit: "stafi",
			verb: "að hafa"
		},
		file: {
			unit: "bæti",
			verb: "að hafa"
		},
		array: {
			unit: "hluti",
			verb: "að hafa"
		},
		set: {
			unit: "hluti",
			verb: "að hafa"
		}
	};
	function n(t) {
		return e[t] ?? null;
	}
	const i = {
		regex: "gildi",
		email: "netfang",
		url: "vefslóð",
		emoji: "emoji",
		uuid: "UUID",
		uuidv4: "UUIDv4",
		uuidv6: "UUIDv6",
		nanoid: "nanoid",
		guid: "GUID",
		cuid: "cuid",
		cuid2: "cuid2",
		ulid: "ULID",
		xid: "XID",
		ksuid: "KSUID",
		datetime: "ISO dagsetning og tími",
		date: "ISO dagsetning",
		time: "ISO tími",
		duration: "ISO tímalengd",
		ipv4: "IPv4 address",
		ipv6: "IPv6 address",
		cidrv4: "IPv4 range",
		cidrv6: "IPv6 range",
		base64: "base64-encoded strengur",
		base64url: "base64url-encoded strengur",
		json_string: "JSON strengur",
		e164: "E.164 tölugildi",
		jwt: "JWT",
		template_literal: "gildi"
	}, o = {
		nan: "NaN",
		number: "númer",
		array: "fylki"
	};
	return (t) => {
		switch (t.code) {
			case "invalid_type": {
				const r = o[t.expected] ?? t.expected, a = b(t.input), u = o[a] ?? a;
				return /^[A-Z]/.test(t.expected) ? `Rangt gildi: Þú slóst inn ${u} þar sem á að vera instanceof ${t.expected}` : `Rangt gildi: Þú slóst inn ${u} þar sem á að vera ${r}`;
			}
			case "invalid_value": return t.values.length === 1 ? `Rangt gildi: gert ráð fyrir ${_(t.values[0])}` : `Ógilt val: má vera eitt af eftirfarandi ${v(t.values, "|")}`;
			case "too_big": {
				const r = t.inclusive ? "<=" : "<", a = n(t.origin);
				return a ? `Of stórt: gert er ráð fyrir að ${t.origin ?? "gildi"} hafi ${r}${t.maximum.toString()} ${a.unit ?? "hluti"}` : `Of stórt: gert er ráð fyrir að ${t.origin ?? "gildi"} sé ${r}${t.maximum.toString()}`;
			}
			case "too_small": {
				const r = t.inclusive ? ">=" : ">", a = n(t.origin);
				return a ? `Of lítið: gert er ráð fyrir að ${t.origin} hafi ${r}${t.minimum.toString()} ${a.unit}` : `Of lítið: gert er ráð fyrir að ${t.origin} sé ${r}${t.minimum.toString()}`;
			}
			case "invalid_format": {
				const r = t;
				return r.format === "starts_with" ? `Ógildur strengur: verður að byrja á "${r.prefix}"` : r.format === "ends_with" ? `Ógildur strengur: verður að enda á "${r.suffix}"` : r.format === "includes" ? `Ógildur strengur: verður að innihalda "${r.includes}"` : r.format === "regex" ? `Ógildur strengur: verður að fylgja mynstri ${r.pattern}` : `Rangt ${i[r.format] ?? t.format}`;
			}
			case "not_multiple_of": return `Röng tala: verður að vera margfeldi af ${t.divisor}`;
			case "unrecognized_keys": return `Óþekkt ${t.keys.length > 1 ? "ir lyklar" : "ur lykill"}: ${v(t.keys, ", ")}`;
			case "invalid_key": return `Rangur lykill í ${t.origin}`;
			case "invalid_union": return "Rangt gildi";
			case "invalid_element": return `Rangt gildi í ${t.origin}`;
			default: return "Rangt gildi";
		}
	};
};
function nf() {
	return { localeError: tf() };
}
const rf = () => {
	const e = {
		string: {
			unit: "caratteri",
			verb: "avere"
		},
		file: {
			unit: "byte",
			verb: "avere"
		},
		array: {
			unit: "elementi",
			verb: "avere"
		},
		set: {
			unit: "elementi",
			verb: "avere"
		}
	};
	function n(t) {
		return e[t] ?? null;
	}
	const i = {
		regex: "input",
		email: "indirizzo email",
		url: "URL",
		emoji: "emoji",
		uuid: "UUID",
		uuidv4: "UUIDv4",
		uuidv6: "UUIDv6",
		nanoid: "nanoid",
		guid: "GUID",
		cuid: "cuid",
		cuid2: "cuid2",
		ulid: "ULID",
		xid: "XID",
		ksuid: "KSUID",
		datetime: "data e ora ISO",
		date: "data ISO",
		time: "ora ISO",
		duration: "durata ISO",
		ipv4: "indirizzo IPv4",
		ipv6: "indirizzo IPv6",
		cidrv4: "intervallo IPv4",
		cidrv6: "intervallo IPv6",
		base64: "stringa codificata in base64",
		base64url: "URL codificata in base64",
		json_string: "stringa JSON",
		e164: "numero E.164",
		jwt: "JWT",
		template_literal: "input"
	}, o = {
		nan: "NaN",
		number: "numero",
		array: "vettore"
	};
	return (t) => {
		switch (t.code) {
			case "invalid_type": {
				const r = o[t.expected] ?? t.expected, a = b(t.input), u = o[a] ?? a;
				return /^[A-Z]/.test(t.expected) ? `Input non valido: atteso instanceof ${t.expected}, ricevuto ${u}` : `Input non valido: atteso ${r}, ricevuto ${u}`;
			}
			case "invalid_value": return t.values.length === 1 ? `Input non valido: atteso ${_(t.values[0])}` : `Opzione non valida: atteso uno tra ${v(t.values, "|")}`;
			case "too_big": {
				const r = t.inclusive ? "<=" : "<", a = n(t.origin);
				return a ? `Troppo grande: ${t.origin ?? "valore"} deve avere ${r}${t.maximum.toString()} ${a.unit ?? "elementi"}` : `Troppo grande: ${t.origin ?? "valore"} deve essere ${r}${t.maximum.toString()}`;
			}
			case "too_small": {
				const r = t.inclusive ? ">=" : ">", a = n(t.origin);
				return a ? `Troppo piccolo: ${t.origin} deve avere ${r}${t.minimum.toString()} ${a.unit}` : `Troppo piccolo: ${t.origin} deve essere ${r}${t.minimum.toString()}`;
			}
			case "invalid_format": {
				const r = t;
				return r.format === "starts_with" ? `Stringa non valida: deve iniziare con "${r.prefix}"` : r.format === "ends_with" ? `Stringa non valida: deve terminare con "${r.suffix}"` : r.format === "includes" ? `Stringa non valida: deve includere "${r.includes}"` : r.format === "regex" ? `Stringa non valida: deve corrispondere al pattern ${r.pattern}` : `Input non valido: ${i[r.format] ?? t.format}`;
			}
			case "not_multiple_of": return `Numero non valido: deve essere un multiplo di ${t.divisor}`;
			case "unrecognized_keys": return `Chiav${t.keys.length > 1 ? "i" : "e"} non riconosciut${t.keys.length > 1 ? "e" : "a"}: ${v(t.keys, ", ")}`;
			case "invalid_key": return `Chiave non valida in ${t.origin}`;
			case "invalid_union": return "Input non valido";
			case "invalid_element": return `Valore non valido in ${t.origin}`;
			default: return "Input non valido";
		}
	};
};
function of() {
	return { localeError: rf() };
}
const af = () => {
	const e = {
		string: {
			unit: "文字",
			verb: "である"
		},
		file: {
			unit: "バイト",
			verb: "である"
		},
		array: {
			unit: "要素",
			verb: "である"
		},
		set: {
			unit: "要素",
			verb: "である"
		}
	};
	function n(t) {
		return e[t] ?? null;
	}
	const i = {
		regex: "入力値",
		email: "メールアドレス",
		url: "URL",
		emoji: "絵文字",
		uuid: "UUID",
		uuidv4: "UUIDv4",
		uuidv6: "UUIDv6",
		nanoid: "nanoid",
		guid: "GUID",
		cuid: "cuid",
		cuid2: "cuid2",
		ulid: "ULID",
		xid: "XID",
		ksuid: "KSUID",
		datetime: "ISO日時",
		date: "ISO日付",
		time: "ISO時刻",
		duration: "ISO期間",
		ipv4: "IPv4アドレス",
		ipv6: "IPv6アドレス",
		cidrv4: "IPv4範囲",
		cidrv6: "IPv6範囲",
		base64: "base64エンコード文字列",
		base64url: "base64urlエンコード文字列",
		json_string: "JSON文字列",
		e164: "E.164番号",
		jwt: "JWT",
		template_literal: "入力値"
	}, o = {
		nan: "NaN",
		number: "数値",
		array: "配列"
	};
	return (t) => {
		switch (t.code) {
			case "invalid_type": {
				const r = o[t.expected] ?? t.expected, a = b(t.input), u = o[a] ?? a;
				return /^[A-Z]/.test(t.expected) ? `無効な入力: instanceof ${t.expected}が期待されましたが、${u}が入力されました` : `無効な入力: ${r}が期待されましたが、${u}が入力されました`;
			}
			case "invalid_value": return t.values.length === 1 ? `無効な入力: ${_(t.values[0])}が期待されました` : `無効な選択: ${v(t.values, "、")}のいずれかである必要があります`;
			case "too_big": {
				const r = t.inclusive ? "以下である" : "より小さい", a = n(t.origin);
				return a ? `大きすぎる値: ${t.origin ?? "値"}は${t.maximum.toString()}${a.unit ?? "要素"}${r}必要があります` : `大きすぎる値: ${t.origin ?? "値"}は${t.maximum.toString()}${r}必要があります`;
			}
			case "too_small": {
				const r = t.inclusive ? "以上である" : "より大きい", a = n(t.origin);
				return a ? `小さすぎる値: ${t.origin}は${t.minimum.toString()}${a.unit}${r}必要があります` : `小さすぎる値: ${t.origin}は${t.minimum.toString()}${r}必要があります`;
			}
			case "invalid_format": {
				const r = t;
				return r.format === "starts_with" ? `無効な文字列: "${r.prefix}"で始まる必要があります` : r.format === "ends_with" ? `無効な文字列: "${r.suffix}"で終わる必要があります` : r.format === "includes" ? `無効な文字列: "${r.includes}"を含む必要があります` : r.format === "regex" ? `無効な文字列: パターン${r.pattern}に一致する必要があります` : `無効な${i[r.format] ?? t.format}`;
			}
			case "not_multiple_of": return `無効な数値: ${t.divisor}の倍数である必要があります`;
			case "unrecognized_keys": return `認識されていないキー${t.keys.length > 1 ? "群" : ""}: ${v(t.keys, "、")}`;
			case "invalid_key": return `${t.origin}内の無効なキー`;
			case "invalid_union": return "無効な入力";
			case "invalid_element": return `${t.origin}内の無効な値`;
			default: return "無効な入力";
		}
	};
};
function uf() {
	return { localeError: af() };
}
const cf = () => {
	const e = {
		string: {
			unit: "სიმბოლო",
			verb: "უნდა შეიცავდეს"
		},
		file: {
			unit: "ბაიტი",
			verb: "უნდა შეიცავდეს"
		},
		array: {
			unit: "ელემენტი",
			verb: "უნდა შეიცავდეს"
		},
		set: {
			unit: "ელემენტი",
			verb: "უნდა შეიცავდეს"
		}
	};
	function n(t) {
		return e[t] ?? null;
	}
	const i = {
		regex: "შეყვანა",
		email: "ელ-ფოსტის მისამართი",
		url: "URL",
		emoji: "ემოჯი",
		uuid: "UUID",
		uuidv4: "UUIDv4",
		uuidv6: "UUIDv6",
		nanoid: "nanoid",
		guid: "GUID",
		cuid: "cuid",
		cuid2: "cuid2",
		ulid: "ULID",
		xid: "XID",
		ksuid: "KSUID",
		datetime: "თარიღი-დრო",
		date: "თარიღი",
		time: "დრო",
		duration: "ხანგრძლივობა",
		ipv4: "IPv4 მისამართი",
		ipv6: "IPv6 მისამართი",
		cidrv4: "IPv4 დიაპაზონი",
		cidrv6: "IPv6 დიაპაზონი",
		base64: "base64-კოდირებული ველი",
		base64url: "base64url-კოდირებული ველი",
		json_string: "JSON ველი",
		e164: "E.164 ნომერი",
		jwt: "JWT",
		template_literal: "შეყვანა"
	}, o = {
		nan: "NaN",
		number: "რიცხვი",
		string: "ველი",
		boolean: "ბულეანი",
		function: "ფუნქცია",
		array: "მასივი"
	};
	return (t) => {
		switch (t.code) {
			case "invalid_type": {
				const r = o[t.expected] ?? t.expected, a = b(t.input), u = o[a] ?? a;
				return /^[A-Z]/.test(t.expected) ? `არასწორი შეყვანა: მოსალოდნელი instanceof ${t.expected}, მიღებული ${u}` : `არასწორი შეყვანა: მოსალოდნელი ${r}, მიღებული ${u}`;
			}
			case "invalid_value": return t.values.length === 1 ? `არასწორი შეყვანა: მოსალოდნელი ${_(t.values[0])}` : `არასწორი ვარიანტი: მოსალოდნელია ერთ-ერთი ${v(t.values, "|")}-დან`;
			case "too_big": {
				const r = t.inclusive ? "<=" : "<", a = n(t.origin);
				return a ? `ზედმეტად დიდი: მოსალოდნელი ${t.origin ?? "მნიშვნელობა"} ${a.verb} ${r}${t.maximum.toString()} ${a.unit}` : `ზედმეტად დიდი: მოსალოდნელი ${t.origin ?? "მნიშვნელობა"} იყოს ${r}${t.maximum.toString()}`;
			}
			case "too_small": {
				const r = t.inclusive ? ">=" : ">", a = n(t.origin);
				return a ? `ზედმეტად პატარა: მოსალოდნელი ${t.origin} ${a.verb} ${r}${t.minimum.toString()} ${a.unit}` : `ზედმეტად პატარა: მოსალოდნელი ${t.origin} იყოს ${r}${t.minimum.toString()}`;
			}
			case "invalid_format": {
				const r = t;
				return r.format === "starts_with" ? `არასწორი ველი: უნდა იწყებოდეს "${r.prefix}"-ით` : r.format === "ends_with" ? `არასწორი ველი: უნდა მთავრდებოდეს "${r.suffix}"-ით` : r.format === "includes" ? `არასწორი ველი: უნდა შეიცავდეს "${r.includes}"-ს` : r.format === "regex" ? `არასწორი ველი: უნდა შეესაბამებოდეს შაბლონს ${r.pattern}` : `არასწორი ${i[r.format] ?? t.format}`;
			}
			case "not_multiple_of": return `არასწორი რიცხვი: უნდა იყოს ${t.divisor}-ის ჯერადი`;
			case "unrecognized_keys": return `უცნობი გასაღებ${t.keys.length > 1 ? "ები" : "ი"}: ${v(t.keys, ", ")}`;
			case "invalid_key": return `არასწორი გასაღები ${t.origin}-ში`;
			case "invalid_union": return "არასწორი შეყვანა";
			case "invalid_element": return `არასწორი მნიშვნელობა ${t.origin}-ში`;
			default: return "არასწორი შეყვანა";
		}
	};
};
function lf() {
	return { localeError: cf() };
}
const sf = () => {
	const e = {
		string: {
			unit: "តួអក្សរ",
			verb: "គួរមាន"
		},
		file: {
			unit: "បៃ",
			verb: "គួរមាន"
		},
		array: {
			unit: "ធាតុ",
			verb: "គួរមាន"
		},
		set: {
			unit: "ធាតុ",
			verb: "គួរមាន"
		}
	};
	function n(t) {
		return e[t] ?? null;
	}
	const i = {
		regex: "ទិន្នន័យបញ្ចូល",
		email: "អាសយដ្ឋានអ៊ីមែល",
		url: "URL",
		emoji: "សញ្ញាអារម្មណ៍",
		uuid: "UUID",
		uuidv4: "UUIDv4",
		uuidv6: "UUIDv6",
		nanoid: "nanoid",
		guid: "GUID",
		cuid: "cuid",
		cuid2: "cuid2",
		ulid: "ULID",
		xid: "XID",
		ksuid: "KSUID",
		datetime: "កាលបរិច្ឆេទ និងម៉ោង ISO",
		date: "កាលបរិច្ឆេទ ISO",
		time: "ម៉ោង ISO",
		duration: "រយៈពេល ISO",
		ipv4: "អាសយដ្ឋាន IPv4",
		ipv6: "អាសយដ្ឋាន IPv6",
		cidrv4: "ដែនអាសយដ្ឋាន IPv4",
		cidrv6: "ដែនអាសយដ្ឋាន IPv6",
		base64: "ខ្សែអក្សរអ៊ិកូដ base64",
		base64url: "ខ្សែអក្សរអ៊ិកូដ base64url",
		json_string: "ខ្សែអក្សរ JSON",
		e164: "លេខ E.164",
		jwt: "JWT",
		template_literal: "ទិន្នន័យបញ្ចូល"
	}, o = {
		nan: "NaN",
		number: "លេខ",
		array: "អារេ (Array)",
		null: "គ្មានតម្លៃ (null)"
	};
	return (t) => {
		switch (t.code) {
			case "invalid_type": {
				const r = o[t.expected] ?? t.expected, a = b(t.input), u = o[a] ?? a;
				return /^[A-Z]/.test(t.expected) ? `ទិន្នន័យបញ្ចូលមិនត្រឹមត្រូវ៖ ត្រូវការ instanceof ${t.expected} ប៉ុន្តែទទួលបាន ${u}` : `ទិន្នន័យបញ្ចូលមិនត្រឹមត្រូវ៖ ត្រូវការ ${r} ប៉ុន្តែទទួលបាន ${u}`;
			}
			case "invalid_value": return t.values.length === 1 ? `ទិន្នន័យបញ្ចូលមិនត្រឹមត្រូវ៖ ត្រូវការ ${_(t.values[0])}` : `ជម្រើសមិនត្រឹមត្រូវ៖ ត្រូវជាមួយក្នុងចំណោម ${v(t.values, "|")}`;
			case "too_big": {
				const r = t.inclusive ? "<=" : "<", a = n(t.origin);
				return a ? `ធំពេក៖ ត្រូវការ ${t.origin ?? "តម្លៃ"} ${r} ${t.maximum.toString()} ${a.unit ?? "ធាតុ"}` : `ធំពេក៖ ត្រូវការ ${t.origin ?? "តម្លៃ"} ${r} ${t.maximum.toString()}`;
			}
			case "too_small": {
				const r = t.inclusive ? ">=" : ">", a = n(t.origin);
				return a ? `តូចពេក៖ ត្រូវការ ${t.origin} ${r} ${t.minimum.toString()} ${a.unit}` : `តូចពេក៖ ត្រូវការ ${t.origin} ${r} ${t.minimum.toString()}`;
			}
			case "invalid_format": {
				const r = t;
				return r.format === "starts_with" ? `ខ្សែអក្សរមិនត្រឹមត្រូវ៖ ត្រូវចាប់ផ្តើមដោយ "${r.prefix}"` : r.format === "ends_with" ? `ខ្សែអក្សរមិនត្រឹមត្រូវ៖ ត្រូវបញ្ចប់ដោយ "${r.suffix}"` : r.format === "includes" ? `ខ្សែអក្សរមិនត្រឹមត្រូវ៖ ត្រូវមាន "${r.includes}"` : r.format === "regex" ? `ខ្សែអក្សរមិនត្រឹមត្រូវ៖ ត្រូវតែផ្គូផ្គងនឹងទម្រង់ដែលបានកំណត់ ${r.pattern}` : `មិនត្រឹមត្រូវ៖ ${i[r.format] ?? t.format}`;
			}
			case "not_multiple_of": return `លេខមិនត្រឹមត្រូវ៖ ត្រូវតែជាពហុគុណនៃ ${t.divisor}`;
			case "unrecognized_keys": return `រកឃើញសោមិនស្គាល់៖ ${v(t.keys, ", ")}`;
			case "invalid_key": return `សោមិនត្រឹមត្រូវនៅក្នុង ${t.origin}`;
			case "invalid_union": return "ទិន្នន័យមិនត្រឹមត្រូវ";
			case "invalid_element": return `ទិន្នន័យមិនត្រឹមត្រូវនៅក្នុង ${t.origin}`;
			default: return "ទិន្នន័យមិនត្រឹមត្រូវ";
		}
	};
};
function Qu() {
	return { localeError: sf() };
}
function df() {
	return Qu();
}
const mf = () => {
	const e = {
		string: {
			unit: "문자",
			verb: "to have"
		},
		file: {
			unit: "바이트",
			verb: "to have"
		},
		array: {
			unit: "개",
			verb: "to have"
		},
		set: {
			unit: "개",
			verb: "to have"
		}
	};
	function n(t) {
		return e[t] ?? null;
	}
	const i = {
		regex: "입력",
		email: "이메일 주소",
		url: "URL",
		emoji: "이모지",
		uuid: "UUID",
		uuidv4: "UUIDv4",
		uuidv6: "UUIDv6",
		nanoid: "nanoid",
		guid: "GUID",
		cuid: "cuid",
		cuid2: "cuid2",
		ulid: "ULID",
		xid: "XID",
		ksuid: "KSUID",
		datetime: "ISO 날짜시간",
		date: "ISO 날짜",
		time: "ISO 시간",
		duration: "ISO 기간",
		ipv4: "IPv4 주소",
		ipv6: "IPv6 주소",
		cidrv4: "IPv4 범위",
		cidrv6: "IPv6 범위",
		base64: "base64 인코딩 문자열",
		base64url: "base64url 인코딩 문자열",
		json_string: "JSON 문자열",
		e164: "E.164 번호",
		jwt: "JWT",
		template_literal: "입력"
	}, o = { nan: "NaN" };
	return (t) => {
		switch (t.code) {
			case "invalid_type": {
				const r = o[t.expected] ?? t.expected, a = b(t.input), u = o[a] ?? a;
				return /^[A-Z]/.test(t.expected) ? `잘못된 입력: 예상 타입은 instanceof ${t.expected}, 받은 타입은 ${u}입니다` : `잘못된 입력: 예상 타입은 ${r}, 받은 타입은 ${u}입니다`;
			}
			case "invalid_value": return t.values.length === 1 ? `잘못된 입력: 값은 ${_(t.values[0])} 이어야 합니다` : `잘못된 옵션: ${v(t.values, "또는 ")} 중 하나여야 합니다`;
			case "too_big": {
				const r = t.inclusive ? "이하" : "미만", a = r === "미만" ? "이어야 합니다" : "여야 합니다", u = n(t.origin), l = u?.unit ?? "요소";
				return u ? `${t.origin ?? "값"}이 너무 큽니다: ${t.maximum.toString()}${l} ${r}${a}` : `${t.origin ?? "값"}이 너무 큽니다: ${t.maximum.toString()} ${r}${a}`;
			}
			case "too_small": {
				const r = t.inclusive ? "이상" : "초과", a = r === "이상" ? "이어야 합니다" : "여야 합니다", u = n(t.origin), l = u?.unit ?? "요소";
				return u ? `${t.origin ?? "값"}이 너무 작습니다: ${t.minimum.toString()}${l} ${r}${a}` : `${t.origin ?? "값"}이 너무 작습니다: ${t.minimum.toString()} ${r}${a}`;
			}
			case "invalid_format": {
				const r = t;
				return r.format === "starts_with" ? `잘못된 문자열: "${r.prefix}"(으)로 시작해야 합니다` : r.format === "ends_with" ? `잘못된 문자열: "${r.suffix}"(으)로 끝나야 합니다` : r.format === "includes" ? `잘못된 문자열: "${r.includes}"을(를) 포함해야 합니다` : r.format === "regex" ? `잘못된 문자열: 정규식 ${r.pattern} 패턴과 일치해야 합니다` : `잘못된 ${i[r.format] ?? t.format}`;
			}
			case "not_multiple_of": return `잘못된 숫자: ${t.divisor}의 배수여야 합니다`;
			case "unrecognized_keys": return `인식할 수 없는 키: ${v(t.keys, ", ")}`;
			case "invalid_key": return `잘못된 키: ${t.origin}`;
			case "invalid_union": return "잘못된 입력";
			case "invalid_element": return `잘못된 값: ${t.origin}`;
			default: return "잘못된 입력";
		}
	};
};
function ff() {
	return { localeError: mf() };
}
const Ne = (e) => e.charAt(0).toUpperCase() + e.slice(1);
function Hi(e) {
	const n = Math.abs(e), i = n % 10, o = n % 100;
	return o >= 11 && o <= 19 || i === 0 ? "many" : i === 1 ? "one" : "few";
}
const pf = () => {
	const e = {
		string: {
			unit: {
				one: "simbolis",
				few: "simboliai",
				many: "simbolių"
			},
			verb: {
				smaller: {
					inclusive: "turi būti ne ilgesnė kaip",
					notInclusive: "turi būti trumpesnė kaip"
				},
				bigger: {
					inclusive: "turi būti ne trumpesnė kaip",
					notInclusive: "turi būti ilgesnė kaip"
				}
			}
		},
		file: {
			unit: {
				one: "baitas",
				few: "baitai",
				many: "baitų"
			},
			verb: {
				smaller: {
					inclusive: "turi būti ne didesnis kaip",
					notInclusive: "turi būti mažesnis kaip"
				},
				bigger: {
					inclusive: "turi būti ne mažesnis kaip",
					notInclusive: "turi būti didesnis kaip"
				}
			}
		},
		array: {
			unit: {
				one: "elementą",
				few: "elementus",
				many: "elementų"
			},
			verb: {
				smaller: {
					inclusive: "turi turėti ne daugiau kaip",
					notInclusive: "turi turėti mažiau kaip"
				},
				bigger: {
					inclusive: "turi turėti ne mažiau kaip",
					notInclusive: "turi turėti daugiau kaip"
				}
			}
		},
		set: {
			unit: {
				one: "elementą",
				few: "elementus",
				many: "elementų"
			},
			verb: {
				smaller: {
					inclusive: "turi turėti ne daugiau kaip",
					notInclusive: "turi turėti mažiau kaip"
				},
				bigger: {
					inclusive: "turi turėti ne mažiau kaip",
					notInclusive: "turi turėti daugiau kaip"
				}
			}
		}
	};
	function n(t, r, a, u) {
		const l = e[t] ?? null;
		return l === null ? l : {
			unit: l.unit[r],
			verb: l.verb[u][a ? "inclusive" : "notInclusive"]
		};
	}
	const i = {
		regex: "įvestis",
		email: "el. pašto adresas",
		url: "URL",
		emoji: "jaustukas",
		uuid: "UUID",
		uuidv4: "UUIDv4",
		uuidv6: "UUIDv6",
		nanoid: "nanoid",
		guid: "GUID",
		cuid: "cuid",
		cuid2: "cuid2",
		ulid: "ULID",
		xid: "XID",
		ksuid: "KSUID",
		datetime: "ISO data ir laikas",
		date: "ISO data",
		time: "ISO laikas",
		duration: "ISO trukmė",
		ipv4: "IPv4 adresas",
		ipv6: "IPv6 adresas",
		cidrv4: "IPv4 tinklo prefiksas (CIDR)",
		cidrv6: "IPv6 tinklo prefiksas (CIDR)",
		base64: "base64 užkoduota eilutė",
		base64url: "base64url užkoduota eilutė",
		json_string: "JSON eilutė",
		e164: "E.164 numeris",
		jwt: "JWT",
		template_literal: "įvestis"
	}, o = {
		nan: "NaN",
		number: "skaičius",
		bigint: "sveikasis skaičius",
		string: "eilutė",
		boolean: "loginė reikšmė",
		undefined: "neapibrėžta reikšmė",
		function: "funkcija",
		symbol: "simbolis",
		array: "masyvas",
		object: "objektas",
		null: "nulinė reikšmė"
	};
	return (t) => {
		switch (t.code) {
			case "invalid_type": {
				const r = o[t.expected] ?? t.expected, a = b(t.input), u = o[a] ?? a;
				return /^[A-Z]/.test(t.expected) ? `Gautas tipas ${u}, o tikėtasi - instanceof ${t.expected}` : `Gautas tipas ${u}, o tikėtasi - ${r}`;
			}
			case "invalid_value": return t.values.length === 1 ? `Privalo būti ${_(t.values[0])}` : `Privalo būti vienas iš ${v(t.values, "|")} pasirinkimų`;
			case "too_big": {
				const r = o[t.origin] ?? t.origin, a = n(t.origin, Hi(Number(t.maximum)), t.inclusive ?? !1, "smaller");
				if (a?.verb) return `${Ne(r ?? t.origin ?? "reikšmė")} ${a.verb} ${t.maximum.toString()} ${a.unit ?? "elementų"}`;
				const u = t.inclusive ? "ne didesnis kaip" : "mažesnis kaip";
				return `${Ne(r ?? t.origin ?? "reikšmė")} turi būti ${u} ${t.maximum.toString()} ${a?.unit}`;
			}
			case "too_small": {
				const r = o[t.origin] ?? t.origin, a = n(t.origin, Hi(Number(t.minimum)), t.inclusive ?? !1, "bigger");
				if (a?.verb) return `${Ne(r ?? t.origin ?? "reikšmė")} ${a.verb} ${t.minimum.toString()} ${a.unit ?? "elementų"}`;
				const u = t.inclusive ? "ne mažesnis kaip" : "didesnis kaip";
				return `${Ne(r ?? t.origin ?? "reikšmė")} turi būti ${u} ${t.minimum.toString()} ${a?.unit}`;
			}
			case "invalid_format": {
				const r = t;
				return r.format === "starts_with" ? `Eilutė privalo prasidėti "${r.prefix}"` : r.format === "ends_with" ? `Eilutė privalo pasibaigti "${r.suffix}"` : r.format === "includes" ? `Eilutė privalo įtraukti "${r.includes}"` : r.format === "regex" ? `Eilutė privalo atitikti ${r.pattern}` : `Neteisingas ${i[r.format] ?? t.format}`;
			}
			case "not_multiple_of": return `Skaičius privalo būti ${t.divisor} kartotinis.`;
			case "unrecognized_keys": return `Neatpažint${t.keys.length > 1 ? "i" : "as"} rakt${t.keys.length > 1 ? "ai" : "as"}: ${v(t.keys, ", ")}`;
			case "invalid_key": return "Rastas klaidingas raktas";
			case "invalid_union": return "Klaidinga įvestis";
			case "invalid_element": return `${Ne(o[t.origin] ?? t.origin ?? t.origin ?? "reikšmė")} turi klaidingą įvestį`;
			default: return "Klaidinga įvestis";
		}
	};
};
function vf() {
	return { localeError: pf() };
}
const gf = () => {
	const e = {
		string: {
			unit: "знаци",
			verb: "да имаат"
		},
		file: {
			unit: "бајти",
			verb: "да имаат"
		},
		array: {
			unit: "ставки",
			verb: "да имаат"
		},
		set: {
			unit: "ставки",
			verb: "да имаат"
		}
	};
	function n(t) {
		return e[t] ?? null;
	}
	const i = {
		regex: "внес",
		email: "адреса на е-пошта",
		url: "URL",
		emoji: "емоџи",
		uuid: "UUID",
		uuidv4: "UUIDv4",
		uuidv6: "UUIDv6",
		nanoid: "nanoid",
		guid: "GUID",
		cuid: "cuid",
		cuid2: "cuid2",
		ulid: "ULID",
		xid: "XID",
		ksuid: "KSUID",
		datetime: "ISO датум и време",
		date: "ISO датум",
		time: "ISO време",
		duration: "ISO времетраење",
		ipv4: "IPv4 адреса",
		ipv6: "IPv6 адреса",
		cidrv4: "IPv4 опсег",
		cidrv6: "IPv6 опсег",
		base64: "base64-енкодирана низа",
		base64url: "base64url-енкодирана низа",
		json_string: "JSON низа",
		e164: "E.164 број",
		jwt: "JWT",
		template_literal: "внес"
	}, o = {
		nan: "NaN",
		number: "број",
		array: "низа"
	};
	return (t) => {
		switch (t.code) {
			case "invalid_type": {
				const r = o[t.expected] ?? t.expected, a = b(t.input), u = o[a] ?? a;
				return /^[A-Z]/.test(t.expected) ? `Грешен внес: се очекува instanceof ${t.expected}, примено ${u}` : `Грешен внес: се очекува ${r}, примено ${u}`;
			}
			case "invalid_value": return t.values.length === 1 ? `Invalid input: expected ${_(t.values[0])}` : `Грешана опција: се очекува една ${v(t.values, "|")}`;
			case "too_big": {
				const r = t.inclusive ? "<=" : "<", a = n(t.origin);
				return a ? `Премногу голем: се очекува ${t.origin ?? "вредноста"} да има ${r}${t.maximum.toString()} ${a.unit ?? "елементи"}` : `Премногу голем: се очекува ${t.origin ?? "вредноста"} да биде ${r}${t.maximum.toString()}`;
			}
			case "too_small": {
				const r = t.inclusive ? ">=" : ">", a = n(t.origin);
				return a ? `Премногу мал: се очекува ${t.origin} да има ${r}${t.minimum.toString()} ${a.unit}` : `Премногу мал: се очекува ${t.origin} да биде ${r}${t.minimum.toString()}`;
			}
			case "invalid_format": {
				const r = t;
				return r.format === "starts_with" ? `Неважечка низа: мора да започнува со "${r.prefix}"` : r.format === "ends_with" ? `Неважечка низа: мора да завршува со "${r.suffix}"` : r.format === "includes" ? `Неважечка низа: мора да вклучува "${r.includes}"` : r.format === "regex" ? `Неважечка низа: мора да одгоара на патернот ${r.pattern}` : `Invalid ${i[r.format] ?? t.format}`;
			}
			case "not_multiple_of": return `Грешен број: мора да биде делив со ${t.divisor}`;
			case "unrecognized_keys": return `${t.keys.length > 1 ? "Непрепознаени клучеви" : "Непрепознаен клуч"}: ${v(t.keys, ", ")}`;
			case "invalid_key": return `Грешен клуч во ${t.origin}`;
			case "invalid_union": return "Грешен внес";
			case "invalid_element": return `Грешна вредност во ${t.origin}`;
			default: return "Грешен внес";
		}
	};
};
function hf() {
	return { localeError: gf() };
}
const $f = () => {
	const e = {
		string: {
			unit: "aksara",
			verb: "mempunyai"
		},
		file: {
			unit: "bait",
			verb: "mempunyai"
		},
		array: {
			unit: "elemen",
			verb: "mempunyai"
		},
		set: {
			unit: "elemen",
			verb: "mempunyai"
		}
	};
	function n(t) {
		return e[t] ?? null;
	}
	const i = {
		regex: "input",
		email: "alamat e-mel",
		url: "URL",
		emoji: "emoji",
		uuid: "UUID",
		uuidv4: "UUIDv4",
		uuidv6: "UUIDv6",
		nanoid: "nanoid",
		guid: "GUID",
		cuid: "cuid",
		cuid2: "cuid2",
		ulid: "ULID",
		xid: "XID",
		ksuid: "KSUID",
		datetime: "tarikh masa ISO",
		date: "tarikh ISO",
		time: "masa ISO",
		duration: "tempoh ISO",
		ipv4: "alamat IPv4",
		ipv6: "alamat IPv6",
		cidrv4: "julat IPv4",
		cidrv6: "julat IPv6",
		base64: "string dikodkan base64",
		base64url: "string dikodkan base64url",
		json_string: "string JSON",
		e164: "nombor E.164",
		jwt: "JWT",
		template_literal: "input"
	}, o = {
		nan: "NaN",
		number: "nombor"
	};
	return (t) => {
		switch (t.code) {
			case "invalid_type": {
				const r = o[t.expected] ?? t.expected, a = b(t.input), u = o[a] ?? a;
				return /^[A-Z]/.test(t.expected) ? `Input tidak sah: dijangka instanceof ${t.expected}, diterima ${u}` : `Input tidak sah: dijangka ${r}, diterima ${u}`;
			}
			case "invalid_value": return t.values.length === 1 ? `Input tidak sah: dijangka ${_(t.values[0])}` : `Pilihan tidak sah: dijangka salah satu daripada ${v(t.values, "|")}`;
			case "too_big": {
				const r = t.inclusive ? "<=" : "<", a = n(t.origin);
				return a ? `Terlalu besar: dijangka ${t.origin ?? "nilai"} ${a.verb} ${r}${t.maximum.toString()} ${a.unit ?? "elemen"}` : `Terlalu besar: dijangka ${t.origin ?? "nilai"} adalah ${r}${t.maximum.toString()}`;
			}
			case "too_small": {
				const r = t.inclusive ? ">=" : ">", a = n(t.origin);
				return a ? `Terlalu kecil: dijangka ${t.origin} ${a.verb} ${r}${t.minimum.toString()} ${a.unit}` : `Terlalu kecil: dijangka ${t.origin} adalah ${r}${t.minimum.toString()}`;
			}
			case "invalid_format": {
				const r = t;
				return r.format === "starts_with" ? `String tidak sah: mesti bermula dengan "${r.prefix}"` : r.format === "ends_with" ? `String tidak sah: mesti berakhir dengan "${r.suffix}"` : r.format === "includes" ? `String tidak sah: mesti mengandungi "${r.includes}"` : r.format === "regex" ? `String tidak sah: mesti sepadan dengan corak ${r.pattern}` : `${i[r.format] ?? t.format} tidak sah`;
			}
			case "not_multiple_of": return `Nombor tidak sah: perlu gandaan ${t.divisor}`;
			case "unrecognized_keys": return `Kunci tidak dikenali: ${v(t.keys, ", ")}`;
			case "invalid_key": return `Kunci tidak sah dalam ${t.origin}`;
			case "invalid_union": return "Input tidak sah";
			case "invalid_element": return `Nilai tidak sah dalam ${t.origin}`;
			default: return "Input tidak sah";
		}
	};
};
function _f() {
	return { localeError: $f() };
}
const bf = () => {
	const e = {
		string: {
			unit: "tekens",
			verb: "heeft"
		},
		file: {
			unit: "bytes",
			verb: "heeft"
		},
		array: {
			unit: "elementen",
			verb: "heeft"
		},
		set: {
			unit: "elementen",
			verb: "heeft"
		}
	};
	function n(t) {
		return e[t] ?? null;
	}
	const i = {
		regex: "invoer",
		email: "emailadres",
		url: "URL",
		emoji: "emoji",
		uuid: "UUID",
		uuidv4: "UUIDv4",
		uuidv6: "UUIDv6",
		nanoid: "nanoid",
		guid: "GUID",
		cuid: "cuid",
		cuid2: "cuid2",
		ulid: "ULID",
		xid: "XID",
		ksuid: "KSUID",
		datetime: "ISO datum en tijd",
		date: "ISO datum",
		time: "ISO tijd",
		duration: "ISO duur",
		ipv4: "IPv4-adres",
		ipv6: "IPv6-adres",
		cidrv4: "IPv4-bereik",
		cidrv6: "IPv6-bereik",
		base64: "base64-gecodeerde tekst",
		base64url: "base64 URL-gecodeerde tekst",
		json_string: "JSON string",
		e164: "E.164-nummer",
		jwt: "JWT",
		template_literal: "invoer"
	}, o = {
		nan: "NaN",
		number: "getal"
	};
	return (t) => {
		switch (t.code) {
			case "invalid_type": {
				const r = o[t.expected] ?? t.expected, a = b(t.input), u = o[a] ?? a;
				return /^[A-Z]/.test(t.expected) ? `Ongeldige invoer: verwacht instanceof ${t.expected}, ontving ${u}` : `Ongeldige invoer: verwacht ${r}, ontving ${u}`;
			}
			case "invalid_value": return t.values.length === 1 ? `Ongeldige invoer: verwacht ${_(t.values[0])}` : `Ongeldige optie: verwacht één van ${v(t.values, "|")}`;
			case "too_big": {
				const r = t.inclusive ? "<=" : "<", a = n(t.origin), u = t.origin === "date" ? "laat" : t.origin === "string" ? "lang" : "groot";
				return a ? `Te ${u}: verwacht dat ${t.origin ?? "waarde"} ${r}${t.maximum.toString()} ${a.unit ?? "elementen"} ${a.verb}` : `Te ${u}: verwacht dat ${t.origin ?? "waarde"} ${r}${t.maximum.toString()} is`;
			}
			case "too_small": {
				const r = t.inclusive ? ">=" : ">", a = n(t.origin), u = t.origin === "date" ? "vroeg" : t.origin === "string" ? "kort" : "klein";
				return a ? `Te ${u}: verwacht dat ${t.origin} ${r}${t.minimum.toString()} ${a.unit} ${a.verb}` : `Te ${u}: verwacht dat ${t.origin} ${r}${t.minimum.toString()} is`;
			}
			case "invalid_format": {
				const r = t;
				return r.format === "starts_with" ? `Ongeldige tekst: moet met "${r.prefix}" beginnen` : r.format === "ends_with" ? `Ongeldige tekst: moet op "${r.suffix}" eindigen` : r.format === "includes" ? `Ongeldige tekst: moet "${r.includes}" bevatten` : r.format === "regex" ? `Ongeldige tekst: moet overeenkomen met patroon ${r.pattern}` : `Ongeldig: ${i[r.format] ?? t.format}`;
			}
			case "not_multiple_of": return `Ongeldig getal: moet een veelvoud van ${t.divisor} zijn`;
			case "unrecognized_keys": return `Onbekende key${t.keys.length > 1 ? "s" : ""}: ${v(t.keys, ", ")}`;
			case "invalid_key": return `Ongeldige key in ${t.origin}`;
			case "invalid_union": return "Ongeldige invoer";
			case "invalid_element": return `Ongeldige waarde in ${t.origin}`;
			default: return "Ongeldige invoer";
		}
	};
};
function yf() {
	return { localeError: bf() };
}
const kf = () => {
	const e = {
		string: {
			unit: "tegn",
			verb: "å ha"
		},
		file: {
			unit: "bytes",
			verb: "å ha"
		},
		array: {
			unit: "elementer",
			verb: "å inneholde"
		},
		set: {
			unit: "elementer",
			verb: "å inneholde"
		}
	};
	function n(t) {
		return e[t] ?? null;
	}
	const i = {
		regex: "input",
		email: "e-postadresse",
		url: "URL",
		emoji: "emoji",
		uuid: "UUID",
		uuidv4: "UUIDv4",
		uuidv6: "UUIDv6",
		nanoid: "nanoid",
		guid: "GUID",
		cuid: "cuid",
		cuid2: "cuid2",
		ulid: "ULID",
		xid: "XID",
		ksuid: "KSUID",
		datetime: "ISO dato- og klokkeslett",
		date: "ISO-dato",
		time: "ISO-klokkeslett",
		duration: "ISO-varighet",
		ipv4: "IPv4-område",
		ipv6: "IPv6-område",
		cidrv4: "IPv4-spekter",
		cidrv6: "IPv6-spekter",
		base64: "base64-enkodet streng",
		base64url: "base64url-enkodet streng",
		json_string: "JSON-streng",
		e164: "E.164-nummer",
		jwt: "JWT",
		template_literal: "input"
	}, o = {
		nan: "NaN",
		number: "tall",
		array: "liste"
	};
	return (t) => {
		switch (t.code) {
			case "invalid_type": {
				const r = o[t.expected] ?? t.expected, a = b(t.input), u = o[a] ?? a;
				return /^[A-Z]/.test(t.expected) ? `Ugyldig input: forventet instanceof ${t.expected}, fikk ${u}` : `Ugyldig input: forventet ${r}, fikk ${u}`;
			}
			case "invalid_value": return t.values.length === 1 ? `Ugyldig verdi: forventet ${_(t.values[0])}` : `Ugyldig valg: forventet en av ${v(t.values, "|")}`;
			case "too_big": {
				const r = t.inclusive ? "<=" : "<", a = n(t.origin);
				return a ? `For stor(t): forventet ${t.origin ?? "value"} til å ha ${r}${t.maximum.toString()} ${a.unit ?? "elementer"}` : `For stor(t): forventet ${t.origin ?? "value"} til å ha ${r}${t.maximum.toString()}`;
			}
			case "too_small": {
				const r = t.inclusive ? ">=" : ">", a = n(t.origin);
				return a ? `For lite(n): forventet ${t.origin} til å ha ${r}${t.minimum.toString()} ${a.unit}` : `For lite(n): forventet ${t.origin} til å ha ${r}${t.minimum.toString()}`;
			}
			case "invalid_format": {
				const r = t;
				return r.format === "starts_with" ? `Ugyldig streng: må starte med "${r.prefix}"` : r.format === "ends_with" ? `Ugyldig streng: må ende med "${r.suffix}"` : r.format === "includes" ? `Ugyldig streng: må inneholde "${r.includes}"` : r.format === "regex" ? `Ugyldig streng: må matche mønsteret ${r.pattern}` : `Ugyldig ${i[r.format] ?? t.format}`;
			}
			case "not_multiple_of": return `Ugyldig tall: må være et multiplum av ${t.divisor}`;
			case "unrecognized_keys": return `${t.keys.length > 1 ? "Ukjente nøkler" : "Ukjent nøkkel"}: ${v(t.keys, ", ")}`;
			case "invalid_key": return `Ugyldig nøkkel i ${t.origin}`;
			case "invalid_union": return "Ugyldig input";
			case "invalid_element": return `Ugyldig verdi i ${t.origin}`;
			default: return "Ugyldig input";
		}
	};
};
function Sf() {
	return { localeError: kf() };
}
const If = () => {
	const e = {
		string: {
			unit: "harf",
			verb: "olmalıdır"
		},
		file: {
			unit: "bayt",
			verb: "olmalıdır"
		},
		array: {
			unit: "unsur",
			verb: "olmalıdır"
		},
		set: {
			unit: "unsur",
			verb: "olmalıdır"
		}
	};
	function n(t) {
		return e[t] ?? null;
	}
	const i = {
		regex: "giren",
		email: "epostagâh",
		url: "URL",
		emoji: "emoji",
		uuid: "UUID",
		uuidv4: "UUIDv4",
		uuidv6: "UUIDv6",
		nanoid: "nanoid",
		guid: "GUID",
		cuid: "cuid",
		cuid2: "cuid2",
		ulid: "ULID",
		xid: "XID",
		ksuid: "KSUID",
		datetime: "ISO hengâmı",
		date: "ISO tarihi",
		time: "ISO zamanı",
		duration: "ISO müddeti",
		ipv4: "IPv4 nişânı",
		ipv6: "IPv6 nişânı",
		cidrv4: "IPv4 menzili",
		cidrv6: "IPv6 menzili",
		base64: "base64-şifreli metin",
		base64url: "base64url-şifreli metin",
		json_string: "JSON metin",
		e164: "E.164 sayısı",
		jwt: "JWT",
		template_literal: "giren"
	}, o = {
		nan: "NaN",
		number: "numara",
		array: "saf",
		null: "gayb"
	};
	return (t) => {
		switch (t.code) {
			case "invalid_type": {
				const r = o[t.expected] ?? t.expected, a = b(t.input), u = o[a] ?? a;
				return /^[A-Z]/.test(t.expected) ? `Fâsit giren: umulan instanceof ${t.expected}, alınan ${u}` : `Fâsit giren: umulan ${r}, alınan ${u}`;
			}
			case "invalid_value": return t.values.length === 1 ? `Fâsit giren: umulan ${_(t.values[0])}` : `Fâsit tercih: mûteberler ${v(t.values, "|")}`;
			case "too_big": {
				const r = t.inclusive ? "<=" : "<", a = n(t.origin);
				return a ? `Fazla büyük: ${t.origin ?? "value"}, ${r}${t.maximum.toString()} ${a.unit ?? "elements"} sahip olmalıydı.` : `Fazla büyük: ${t.origin ?? "value"}, ${r}${t.maximum.toString()} olmalıydı.`;
			}
			case "too_small": {
				const r = t.inclusive ? ">=" : ">", a = n(t.origin);
				return a ? `Fazla küçük: ${t.origin}, ${r}${t.minimum.toString()} ${a.unit} sahip olmalıydı.` : `Fazla küçük: ${t.origin}, ${r}${t.minimum.toString()} olmalıydı.`;
			}
			case "invalid_format": {
				const r = t;
				return r.format === "starts_with" ? `Fâsit metin: "${r.prefix}" ile başlamalı.` : r.format === "ends_with" ? `Fâsit metin: "${r.suffix}" ile bitmeli.` : r.format === "includes" ? `Fâsit metin: "${r.includes}" ihtivâ etmeli.` : r.format === "regex" ? `Fâsit metin: ${r.pattern} nakşına uymalı.` : `Fâsit ${i[r.format] ?? t.format}`;
			}
			case "not_multiple_of": return `Fâsit sayı: ${t.divisor} katı olmalıydı.`;
			case "unrecognized_keys": return `Tanınmayan anahtar ${t.keys.length > 1 ? "s" : ""}: ${v(t.keys, ", ")}`;
			case "invalid_key": return `${t.origin} için tanınmayan anahtar var.`;
			case "invalid_union": return "Giren tanınamadı.";
			case "invalid_element": return `${t.origin} için tanınmayan kıymet var.`;
			default: return "Kıymet tanınamadı.";
		}
	};
};
function zf() {
	return { localeError: If() };
}
const wf = () => {
	const e = {
		string: {
			unit: "توکي",
			verb: "ولري"
		},
		file: {
			unit: "بایټس",
			verb: "ولري"
		},
		array: {
			unit: "توکي",
			verb: "ولري"
		},
		set: {
			unit: "توکي",
			verb: "ولري"
		}
	};
	function n(t) {
		return e[t] ?? null;
	}
	const i = {
		regex: "ورودي",
		email: "بریښنالیک",
		url: "یو آر ال",
		emoji: "ایموجي",
		uuid: "UUID",
		uuidv4: "UUIDv4",
		uuidv6: "UUIDv6",
		nanoid: "nanoid",
		guid: "GUID",
		cuid: "cuid",
		cuid2: "cuid2",
		ulid: "ULID",
		xid: "XID",
		ksuid: "KSUID",
		datetime: "نیټه او وخت",
		date: "نېټه",
		time: "وخت",
		duration: "موده",
		ipv4: "د IPv4 پته",
		ipv6: "د IPv6 پته",
		cidrv4: "د IPv4 ساحه",
		cidrv6: "د IPv6 ساحه",
		base64: "base64-encoded متن",
		base64url: "base64url-encoded متن",
		json_string: "JSON متن",
		e164: "د E.164 شمېره",
		jwt: "JWT",
		template_literal: "ورودي"
	}, o = {
		nan: "NaN",
		number: "عدد",
		array: "ارې"
	};
	return (t) => {
		switch (t.code) {
			case "invalid_type": {
				const r = o[t.expected] ?? t.expected, a = b(t.input), u = o[a] ?? a;
				return /^[A-Z]/.test(t.expected) ? `ناسم ورودي: باید instanceof ${t.expected} وای, مګر ${u} ترلاسه شو` : `ناسم ورودي: باید ${r} وای, مګر ${u} ترلاسه شو`;
			}
			case "invalid_value": return t.values.length === 1 ? `ناسم ورودي: باید ${_(t.values[0])} وای` : `ناسم انتخاب: باید یو له ${v(t.values, "|")} څخه وای`;
			case "too_big": {
				const r = t.inclusive ? "<=" : "<", a = n(t.origin);
				return a ? `ډیر لوی: ${t.origin ?? "ارزښت"} باید ${r}${t.maximum.toString()} ${a.unit ?? "عنصرونه"} ولري` : `ډیر لوی: ${t.origin ?? "ارزښت"} باید ${r}${t.maximum.toString()} وي`;
			}
			case "too_small": {
				const r = t.inclusive ? ">=" : ">", a = n(t.origin);
				return a ? `ډیر کوچنی: ${t.origin} باید ${r}${t.minimum.toString()} ${a.unit} ولري` : `ډیر کوچنی: ${t.origin} باید ${r}${t.minimum.toString()} وي`;
			}
			case "invalid_format": {
				const r = t;
				return r.format === "starts_with" ? `ناسم متن: باید د "${r.prefix}" سره پیل شي` : r.format === "ends_with" ? `ناسم متن: باید د "${r.suffix}" سره پای ته ورسيږي` : r.format === "includes" ? `ناسم متن: باید "${r.includes}" ولري` : r.format === "regex" ? `ناسم متن: باید د ${r.pattern} سره مطابقت ولري` : `${i[r.format] ?? t.format} ناسم دی`;
			}
			case "not_multiple_of": return `ناسم عدد: باید د ${t.divisor} مضرب وي`;
			case "unrecognized_keys": return `ناسم ${t.keys.length > 1 ? "کلیډونه" : "کلیډ"}: ${v(t.keys, ", ")}`;
			case "invalid_key": return `ناسم کلیډ په ${t.origin} کې`;
			case "invalid_union": return "ناسمه ورودي";
			case "invalid_element": return `ناسم عنصر په ${t.origin} کې`;
			default: return "ناسمه ورودي";
		}
	};
};
function xf() {
	return { localeError: wf() };
}
const Zf = () => {
	const e = {
		string: {
			unit: "znaków",
			verb: "mieć"
		},
		file: {
			unit: "bajtów",
			verb: "mieć"
		},
		array: {
			unit: "elementów",
			verb: "mieć"
		},
		set: {
			unit: "elementów",
			verb: "mieć"
		}
	};
	function n(t) {
		return e[t] ?? null;
	}
	const i = {
		regex: "wyrażenie",
		email: "adres email",
		url: "URL",
		emoji: "emoji",
		uuid: "UUID",
		uuidv4: "UUIDv4",
		uuidv6: "UUIDv6",
		nanoid: "nanoid",
		guid: "GUID",
		cuid: "cuid",
		cuid2: "cuid2",
		ulid: "ULID",
		xid: "XID",
		ksuid: "KSUID",
		datetime: "data i godzina w formacie ISO",
		date: "data w formacie ISO",
		time: "godzina w formacie ISO",
		duration: "czas trwania ISO",
		ipv4: "adres IPv4",
		ipv6: "adres IPv6",
		cidrv4: "zakres IPv4",
		cidrv6: "zakres IPv6",
		base64: "ciąg znaków zakodowany w formacie base64",
		base64url: "ciąg znaków zakodowany w formacie base64url",
		json_string: "ciąg znaków w formacie JSON",
		e164: "liczba E.164",
		jwt: "JWT",
		template_literal: "wejście"
	}, o = {
		nan: "NaN",
		number: "liczba",
		array: "tablica"
	};
	return (t) => {
		switch (t.code) {
			case "invalid_type": {
				const r = o[t.expected] ?? t.expected, a = b(t.input), u = o[a] ?? a;
				return /^[A-Z]/.test(t.expected) ? `Nieprawidłowe dane wejściowe: oczekiwano instanceof ${t.expected}, otrzymano ${u}` : `Nieprawidłowe dane wejściowe: oczekiwano ${r}, otrzymano ${u}`;
			}
			case "invalid_value": return t.values.length === 1 ? `Nieprawidłowe dane wejściowe: oczekiwano ${_(t.values[0])}` : `Nieprawidłowa opcja: oczekiwano jednej z wartości ${v(t.values, "|")}`;
			case "too_big": {
				const r = t.inclusive ? "<=" : "<", a = n(t.origin);
				return a ? `Za duża wartość: oczekiwano, że ${t.origin ?? "wartość"} będzie mieć ${r}${t.maximum.toString()} ${a.unit ?? "elementów"}` : `Zbyt duż(y/a/e): oczekiwano, że ${t.origin ?? "wartość"} będzie wynosić ${r}${t.maximum.toString()}`;
			}
			case "too_small": {
				const r = t.inclusive ? ">=" : ">", a = n(t.origin);
				return a ? `Za mała wartość: oczekiwano, że ${t.origin ?? "wartość"} będzie mieć ${r}${t.minimum.toString()} ${a.unit ?? "elementów"}` : `Zbyt mał(y/a/e): oczekiwano, że ${t.origin ?? "wartość"} będzie wynosić ${r}${t.minimum.toString()}`;
			}
			case "invalid_format": {
				const r = t;
				return r.format === "starts_with" ? `Nieprawidłowy ciąg znaków: musi zaczynać się od "${r.prefix}"` : r.format === "ends_with" ? `Nieprawidłowy ciąg znaków: musi kończyć się na "${r.suffix}"` : r.format === "includes" ? `Nieprawidłowy ciąg znaków: musi zawierać "${r.includes}"` : r.format === "regex" ? `Nieprawidłowy ciąg znaków: musi odpowiadać wzorcowi ${r.pattern}` : `Nieprawidłow(y/a/e) ${i[r.format] ?? t.format}`;
			}
			case "not_multiple_of": return `Nieprawidłowa liczba: musi być wielokrotnością ${t.divisor}`;
			case "unrecognized_keys": return `Nierozpoznane klucze${t.keys.length > 1 ? "s" : ""}: ${v(t.keys, ", ")}`;
			case "invalid_key": return `Nieprawidłowy klucz w ${t.origin}`;
			case "invalid_union": return "Nieprawidłowe dane wejściowe";
			case "invalid_element": return `Nieprawidłowa wartość w ${t.origin}`;
			default: return "Nieprawidłowe dane wejściowe";
		}
	};
};
function Uf() {
	return { localeError: Zf() };
}
const jf = () => {
	const e = {
		string: {
			unit: "caracteres",
			verb: "ter"
		},
		file: {
			unit: "bytes",
			verb: "ter"
		},
		array: {
			unit: "itens",
			verb: "ter"
		},
		set: {
			unit: "itens",
			verb: "ter"
		}
	};
	function n(t) {
		return e[t] ?? null;
	}
	const i = {
		regex: "padrão",
		email: "endereço de e-mail",
		url: "URL",
		emoji: "emoji",
		uuid: "UUID",
		uuidv4: "UUIDv4",
		uuidv6: "UUIDv6",
		nanoid: "nanoid",
		guid: "GUID",
		cuid: "cuid",
		cuid2: "cuid2",
		ulid: "ULID",
		xid: "XID",
		ksuid: "KSUID",
		datetime: "data e hora ISO",
		date: "data ISO",
		time: "hora ISO",
		duration: "duração ISO",
		ipv4: "endereço IPv4",
		ipv6: "endereço IPv6",
		cidrv4: "faixa de IPv4",
		cidrv6: "faixa de IPv6",
		base64: "texto codificado em base64",
		base64url: "URL codificada em base64",
		json_string: "texto JSON",
		e164: "número E.164",
		jwt: "JWT",
		template_literal: "entrada"
	}, o = {
		nan: "NaN",
		number: "número",
		null: "nulo"
	};
	return (t) => {
		switch (t.code) {
			case "invalid_type": {
				const r = o[t.expected] ?? t.expected, a = b(t.input), u = o[a] ?? a;
				return /^[A-Z]/.test(t.expected) ? `Tipo inválido: esperado instanceof ${t.expected}, recebido ${u}` : `Tipo inválido: esperado ${r}, recebido ${u}`;
			}
			case "invalid_value": return t.values.length === 1 ? `Entrada inválida: esperado ${_(t.values[0])}` : `Opção inválida: esperada uma das ${v(t.values, "|")}`;
			case "too_big": {
				const r = t.inclusive ? "<=" : "<", a = n(t.origin);
				return a ? `Muito grande: esperado que ${t.origin ?? "valor"} tivesse ${r}${t.maximum.toString()} ${a.unit ?? "elementos"}` : `Muito grande: esperado que ${t.origin ?? "valor"} fosse ${r}${t.maximum.toString()}`;
			}
			case "too_small": {
				const r = t.inclusive ? ">=" : ">", a = n(t.origin);
				return a ? `Muito pequeno: esperado que ${t.origin} tivesse ${r}${t.minimum.toString()} ${a.unit}` : `Muito pequeno: esperado que ${t.origin} fosse ${r}${t.minimum.toString()}`;
			}
			case "invalid_format": {
				const r = t;
				return r.format === "starts_with" ? `Texto inválido: deve começar com "${r.prefix}"` : r.format === "ends_with" ? `Texto inválido: deve terminar com "${r.suffix}"` : r.format === "includes" ? `Texto inválido: deve incluir "${r.includes}"` : r.format === "regex" ? `Texto inválido: deve corresponder ao padrão ${r.pattern}` : `${i[r.format] ?? t.format} inválido`;
			}
			case "not_multiple_of": return `Número inválido: deve ser múltiplo de ${t.divisor}`;
			case "unrecognized_keys": return `Chave${t.keys.length > 1 ? "s" : ""} desconhecida${t.keys.length > 1 ? "s" : ""}: ${v(t.keys, ", ")}`;
			case "invalid_key": return `Chave inválida em ${t.origin}`;
			case "invalid_union": return "Entrada inválida";
			case "invalid_element": return `Valor inválido em ${t.origin}`;
			default: return "Campo inválido";
		}
	};
};
function Df() {
	return { localeError: jf() };
}
const Of = () => {
	const e = {
		string: {
			unit: "caractere",
			verb: "să aibă"
		},
		file: {
			unit: "octeți",
			verb: "să aibă"
		},
		array: {
			unit: "elemente",
			verb: "să aibă"
		},
		set: {
			unit: "elemente",
			verb: "să aibă"
		},
		map: {
			unit: "intrări",
			verb: "să aibă"
		}
	};
	function n(t) {
		return e[t] ?? null;
	}
	const i = {
		regex: "intrare",
		email: "adresă de email",
		url: "URL",
		emoji: "emoji",
		uuid: "UUID",
		uuidv4: "UUIDv4",
		uuidv6: "UUIDv6",
		nanoid: "nanoid",
		guid: "GUID",
		cuid: "cuid",
		cuid2: "cuid2",
		ulid: "ULID",
		xid: "XID",
		ksuid: "KSUID",
		datetime: "dată și oră ISO",
		date: "dată ISO",
		time: "oră ISO",
		duration: "durată ISO",
		ipv4: "adresă IPv4",
		ipv6: "adresă IPv6",
		mac: "adresă MAC",
		cidrv4: "interval IPv4",
		cidrv6: "interval IPv6",
		base64: "șir codat base64",
		base64url: "șir codat base64url",
		json_string: "șir JSON",
		e164: "număr E.164",
		jwt: "JWT",
		template_literal: "intrare"
	}, o = {
		nan: "NaN",
		string: "șir",
		number: "număr",
		boolean: "boolean",
		function: "funcție",
		array: "matrice",
		object: "obiect",
		undefined: "nedefinit",
		symbol: "simbol",
		bigint: "număr mare",
		void: "void",
		never: "never",
		map: "hartă",
		set: "set"
	};
	return (t) => {
		switch (t.code) {
			case "invalid_type": {
				const r = o[t.expected] ?? t.expected, a = b(t.input);
				return `Intrare invalidă: așteptat ${r}, primit ${o[a] ?? a}`;
			}
			case "invalid_value": return t.values.length === 1 ? `Intrare invalidă: așteptat ${_(t.values[0])}` : `Opțiune invalidă: așteptat una dintre ${v(t.values, "|")}`;
			case "too_big": {
				const r = t.inclusive ? "<=" : "<", a = n(t.origin);
				return a ? `Prea mare: așteptat ca ${t.origin ?? "valoarea"} ${a.verb} ${r}${t.maximum.toString()} ${a.unit ?? "elemente"}` : `Prea mare: așteptat ca ${t.origin ?? "valoarea"} să fie ${r}${t.maximum.toString()}`;
			}
			case "too_small": {
				const r = t.inclusive ? ">=" : ">", a = n(t.origin);
				return a ? `Prea mic: așteptat ca ${t.origin} ${a.verb} ${r}${t.minimum.toString()} ${a.unit}` : `Prea mic: așteptat ca ${t.origin} să fie ${r}${t.minimum.toString()}`;
			}
			case "invalid_format": {
				const r = t;
				return r.format === "starts_with" ? `Șir invalid: trebuie să înceapă cu "${r.prefix}"` : r.format === "ends_with" ? `Șir invalid: trebuie să se termine cu "${r.suffix}"` : r.format === "includes" ? `Șir invalid: trebuie să includă "${r.includes}"` : r.format === "regex" ? `Șir invalid: trebuie să se potrivească cu modelul ${r.pattern}` : `Format invalid: ${i[r.format] ?? t.format}`;
			}
			case "not_multiple_of": return `Număr invalid: trebuie să fie multiplu de ${t.divisor}`;
			case "unrecognized_keys": return `Chei nerecunoscute: ${v(t.keys, ", ")}`;
			case "invalid_key": return `Cheie invalidă în ${t.origin}`;
			case "invalid_union": return "Intrare invalidă";
			case "invalid_element": return `Valoare invalidă în ${t.origin}`;
			default: return "Intrare invalidă";
		}
	};
};
function Nf() {
	return { localeError: Of() };
}
function Qi(e, n, i, o) {
	const t = Math.abs(e), r = t % 10, a = t % 100;
	return a >= 11 && a <= 19 ? o : r === 1 ? n : r >= 2 && r <= 4 ? i : o;
}
const Pf = () => {
	const e = {
		string: {
			unit: {
				one: "символ",
				few: "символа",
				many: "символов"
			},
			verb: "иметь"
		},
		file: {
			unit: {
				one: "байт",
				few: "байта",
				many: "байт"
			},
			verb: "иметь"
		},
		array: {
			unit: {
				one: "элемент",
				few: "элемента",
				many: "элементов"
			},
			verb: "иметь"
		},
		set: {
			unit: {
				one: "элемент",
				few: "элемента",
				many: "элементов"
			},
			verb: "иметь"
		}
	};
	function n(t) {
		return e[t] ?? null;
	}
	const i = {
		regex: "ввод",
		email: "email адрес",
		url: "URL",
		emoji: "эмодзи",
		uuid: "UUID",
		uuidv4: "UUIDv4",
		uuidv6: "UUIDv6",
		nanoid: "nanoid",
		guid: "GUID",
		cuid: "cuid",
		cuid2: "cuid2",
		ulid: "ULID",
		xid: "XID",
		ksuid: "KSUID",
		datetime: "ISO дата и время",
		date: "ISO дата",
		time: "ISO время",
		duration: "ISO длительность",
		ipv4: "IPv4 адрес",
		ipv6: "IPv6 адрес",
		cidrv4: "IPv4 диапазон",
		cidrv6: "IPv6 диапазон",
		base64: "строка в формате base64",
		base64url: "строка в формате base64url",
		json_string: "JSON строка",
		e164: "номер E.164",
		jwt: "JWT",
		template_literal: "ввод"
	}, o = {
		nan: "NaN",
		number: "число",
		array: "массив"
	};
	return (t) => {
		switch (t.code) {
			case "invalid_type": {
				const r = o[t.expected] ?? t.expected, a = b(t.input), u = o[a] ?? a;
				return /^[A-Z]/.test(t.expected) ? `Неверный ввод: ожидалось instanceof ${t.expected}, получено ${u}` : `Неверный ввод: ожидалось ${r}, получено ${u}`;
			}
			case "invalid_value": return t.values.length === 1 ? `Неверный ввод: ожидалось ${_(t.values[0])}` : `Неверный вариант: ожидалось одно из ${v(t.values, "|")}`;
			case "too_big": {
				const r = t.inclusive ? "<=" : "<", a = n(t.origin);
				if (a) {
					const u = Qi(Number(t.maximum), a.unit.one, a.unit.few, a.unit.many);
					return `Слишком большое значение: ожидалось, что ${t.origin ?? "значение"} будет иметь ${r}${t.maximum.toString()} ${u}`;
				}
				return `Слишком большое значение: ожидалось, что ${t.origin ?? "значение"} будет ${r}${t.maximum.toString()}`;
			}
			case "too_small": {
				const r = t.inclusive ? ">=" : ">", a = n(t.origin);
				if (a) {
					const u = Qi(Number(t.minimum), a.unit.one, a.unit.few, a.unit.many);
					return `Слишком маленькое значение: ожидалось, что ${t.origin} будет иметь ${r}${t.minimum.toString()} ${u}`;
				}
				return `Слишком маленькое значение: ожидалось, что ${t.origin} будет ${r}${t.minimum.toString()}`;
			}
			case "invalid_format": {
				const r = t;
				return r.format === "starts_with" ? `Неверная строка: должна начинаться с "${r.prefix}"` : r.format === "ends_with" ? `Неверная строка: должна заканчиваться на "${r.suffix}"` : r.format === "includes" ? `Неверная строка: должна содержать "${r.includes}"` : r.format === "regex" ? `Неверная строка: должна соответствовать шаблону ${r.pattern}` : `Неверный ${i[r.format] ?? t.format}`;
			}
			case "not_multiple_of": return `Неверное число: должно быть кратным ${t.divisor}`;
			case "unrecognized_keys": return `Нераспознанн${t.keys.length > 1 ? "ые" : "ый"} ключ${t.keys.length > 1 ? "и" : ""}: ${v(t.keys, ", ")}`;
			case "invalid_key": return `Неверный ключ в ${t.origin}`;
			case "invalid_union": return "Неверные входные данные";
			case "invalid_element": return `Неверное значение в ${t.origin}`;
			default: return "Неверные входные данные";
		}
	};
};
function Tf() {
	return { localeError: Pf() };
}
const Ef = () => {
	const e = {
		string: {
			unit: "znakov",
			verb: "imeti"
		},
		file: {
			unit: "bajtov",
			verb: "imeti"
		},
		array: {
			unit: "elementov",
			verb: "imeti"
		},
		set: {
			unit: "elementov",
			verb: "imeti"
		}
	};
	function n(t) {
		return e[t] ?? null;
	}
	const i = {
		regex: "vnos",
		email: "e-poštni naslov",
		url: "URL",
		emoji: "emoji",
		uuid: "UUID",
		uuidv4: "UUIDv4",
		uuidv6: "UUIDv6",
		nanoid: "nanoid",
		guid: "GUID",
		cuid: "cuid",
		cuid2: "cuid2",
		ulid: "ULID",
		xid: "XID",
		ksuid: "KSUID",
		datetime: "ISO datum in čas",
		date: "ISO datum",
		time: "ISO čas",
		duration: "ISO trajanje",
		ipv4: "IPv4 naslov",
		ipv6: "IPv6 naslov",
		cidrv4: "obseg IPv4",
		cidrv6: "obseg IPv6",
		base64: "base64 kodiran niz",
		base64url: "base64url kodiran niz",
		json_string: "JSON niz",
		e164: "E.164 številka",
		jwt: "JWT",
		template_literal: "vnos"
	}, o = {
		nan: "NaN",
		number: "število",
		array: "tabela"
	};
	return (t) => {
		switch (t.code) {
			case "invalid_type": {
				const r = o[t.expected] ?? t.expected, a = b(t.input), u = o[a] ?? a;
				return /^[A-Z]/.test(t.expected) ? `Neveljaven vnos: pričakovano instanceof ${t.expected}, prejeto ${u}` : `Neveljaven vnos: pričakovano ${r}, prejeto ${u}`;
			}
			case "invalid_value": return t.values.length === 1 ? `Neveljaven vnos: pričakovano ${_(t.values[0])}` : `Neveljavna možnost: pričakovano eno izmed ${v(t.values, "|")}`;
			case "too_big": {
				const r = t.inclusive ? "<=" : "<", a = n(t.origin);
				return a ? `Preveliko: pričakovano, da bo ${t.origin ?? "vrednost"} imelo ${r}${t.maximum.toString()} ${a.unit ?? "elementov"}` : `Preveliko: pričakovano, da bo ${t.origin ?? "vrednost"} ${r}${t.maximum.toString()}`;
			}
			case "too_small": {
				const r = t.inclusive ? ">=" : ">", a = n(t.origin);
				return a ? `Premajhno: pričakovano, da bo ${t.origin} imelo ${r}${t.minimum.toString()} ${a.unit}` : `Premajhno: pričakovano, da bo ${t.origin} ${r}${t.minimum.toString()}`;
			}
			case "invalid_format": {
				const r = t;
				return r.format === "starts_with" ? `Neveljaven niz: mora se začeti z "${r.prefix}"` : r.format === "ends_with" ? `Neveljaven niz: mora se končati z "${r.suffix}"` : r.format === "includes" ? `Neveljaven niz: mora vsebovati "${r.includes}"` : r.format === "regex" ? `Neveljaven niz: mora ustrezati vzorcu ${r.pattern}` : `Neveljaven ${i[r.format] ?? t.format}`;
			}
			case "not_multiple_of": return `Neveljavno število: mora biti večkratnik ${t.divisor}`;
			case "unrecognized_keys": return `Neprepoznan${t.keys.length > 1 ? "i ključi" : " ključ"}: ${v(t.keys, ", ")}`;
			case "invalid_key": return `Neveljaven ključ v ${t.origin}`;
			case "invalid_union": return "Neveljaven vnos";
			case "invalid_element": return `Neveljavna vrednost v ${t.origin}`;
			default: return "Neveljaven vnos";
		}
	};
};
function Af() {
	return { localeError: Ef() };
}
const Cf = () => {
	const e = {
		string: {
			unit: "tecken",
			verb: "att ha"
		},
		file: {
			unit: "bytes",
			verb: "att ha"
		},
		array: {
			unit: "objekt",
			verb: "att innehålla"
		},
		set: {
			unit: "objekt",
			verb: "att innehålla"
		}
	};
	function n(t) {
		return e[t] ?? null;
	}
	const i = {
		regex: "reguljärt uttryck",
		email: "e-postadress",
		url: "URL",
		emoji: "emoji",
		uuid: "UUID",
		uuidv4: "UUIDv4",
		uuidv6: "UUIDv6",
		nanoid: "nanoid",
		guid: "GUID",
		cuid: "cuid",
		cuid2: "cuid2",
		ulid: "ULID",
		xid: "XID",
		ksuid: "KSUID",
		datetime: "ISO-datum och tid",
		date: "ISO-datum",
		time: "ISO-tid",
		duration: "ISO-varaktighet",
		ipv4: "IPv4-intervall",
		ipv6: "IPv6-intervall",
		cidrv4: "IPv4-spektrum",
		cidrv6: "IPv6-spektrum",
		base64: "base64-kodad sträng",
		base64url: "base64url-kodad sträng",
		json_string: "JSON-sträng",
		e164: "E.164-nummer",
		jwt: "JWT",
		template_literal: "mall-literal"
	}, o = {
		nan: "NaN",
		number: "antal",
		array: "lista"
	};
	return (t) => {
		switch (t.code) {
			case "invalid_type": {
				const r = o[t.expected] ?? t.expected, a = b(t.input), u = o[a] ?? a;
				return /^[A-Z]/.test(t.expected) ? `Ogiltig inmatning: förväntat instanceof ${t.expected}, fick ${u}` : `Ogiltig inmatning: förväntat ${r}, fick ${u}`;
			}
			case "invalid_value": return t.values.length === 1 ? `Ogiltig inmatning: förväntat ${_(t.values[0])}` : `Ogiltigt val: förväntade en av ${v(t.values, "|")}`;
			case "too_big": {
				const r = t.inclusive ? "<=" : "<", a = n(t.origin);
				return a ? `För stor(t): förväntade ${t.origin ?? "värdet"} att ha ${r}${t.maximum.toString()} ${a.unit ?? "element"}` : `För stor(t): förväntat ${t.origin ?? "värdet"} att ha ${r}${t.maximum.toString()}`;
			}
			case "too_small": {
				const r = t.inclusive ? ">=" : ">", a = n(t.origin);
				return a ? `För lite(t): förväntade ${t.origin ?? "värdet"} att ha ${r}${t.minimum.toString()} ${a.unit}` : `För lite(t): förväntade ${t.origin ?? "värdet"} att ha ${r}${t.minimum.toString()}`;
			}
			case "invalid_format": {
				const r = t;
				return r.format === "starts_with" ? `Ogiltig sträng: måste börja med "${r.prefix}"` : r.format === "ends_with" ? `Ogiltig sträng: måste sluta med "${r.suffix}"` : r.format === "includes" ? `Ogiltig sträng: måste innehålla "${r.includes}"` : r.format === "regex" ? `Ogiltig sträng: måste matcha mönstret "${r.pattern}"` : `Ogiltig(t) ${i[r.format] ?? t.format}`;
			}
			case "not_multiple_of": return `Ogiltigt tal: måste vara en multipel av ${t.divisor}`;
			case "unrecognized_keys": return `${t.keys.length > 1 ? "Okända nycklar" : "Okänd nyckel"}: ${v(t.keys, ", ")}`;
			case "invalid_key": return `Ogiltig nyckel i ${t.origin ?? "värdet"}`;
			case "invalid_union": return "Ogiltig input";
			case "invalid_element": return `Ogiltigt värde i ${t.origin ?? "värdet"}`;
			default: return "Ogiltig input";
		}
	};
};
function Rf() {
	return { localeError: Cf() };
}
const Lf = () => {
	const e = {
		string: {
			unit: "எழுத்துக்கள்",
			verb: "கொண்டிருக்க வேண்டும்"
		},
		file: {
			unit: "பைட்டுகள்",
			verb: "கொண்டிருக்க வேண்டும்"
		},
		array: {
			unit: "உறுப்புகள்",
			verb: "கொண்டிருக்க வேண்டும்"
		},
		set: {
			unit: "உறுப்புகள்",
			verb: "கொண்டிருக்க வேண்டும்"
		}
	};
	function n(t) {
		return e[t] ?? null;
	}
	const i = {
		regex: "உள்ளீடு",
		email: "மின்னஞ்சல் முகவரி",
		url: "URL",
		emoji: "emoji",
		uuid: "UUID",
		uuidv4: "UUIDv4",
		uuidv6: "UUIDv6",
		nanoid: "nanoid",
		guid: "GUID",
		cuid: "cuid",
		cuid2: "cuid2",
		ulid: "ULID",
		xid: "XID",
		ksuid: "KSUID",
		datetime: "ISO தேதி நேரம்",
		date: "ISO தேதி",
		time: "ISO நேரம்",
		duration: "ISO கால அளவு",
		ipv4: "IPv4 முகவரி",
		ipv6: "IPv6 முகவரி",
		cidrv4: "IPv4 வரம்பு",
		cidrv6: "IPv6 வரம்பு",
		base64: "base64-encoded சரம்",
		base64url: "base64url-encoded சரம்",
		json_string: "JSON சரம்",
		e164: "E.164 எண்",
		jwt: "JWT",
		template_literal: "input"
	}, o = {
		nan: "NaN",
		number: "எண்",
		array: "அணி",
		null: "வெறுமை"
	};
	return (t) => {
		switch (t.code) {
			case "invalid_type": {
				const r = o[t.expected] ?? t.expected, a = b(t.input), u = o[a] ?? a;
				return /^[A-Z]/.test(t.expected) ? `தவறான உள்ளீடு: எதிர்பார்க்கப்பட்டது instanceof ${t.expected}, பெறப்பட்டது ${u}` : `தவறான உள்ளீடு: எதிர்பார்க்கப்பட்டது ${r}, பெறப்பட்டது ${u}`;
			}
			case "invalid_value": return t.values.length === 1 ? `தவறான உள்ளீடு: எதிர்பார்க்கப்பட்டது ${_(t.values[0])}` : `தவறான விருப்பம்: எதிர்பார்க்கப்பட்டது ${v(t.values, "|")} இல் ஒன்று`;
			case "too_big": {
				const r = t.inclusive ? "<=" : "<", a = n(t.origin);
				return a ? `மிக பெரியது: எதிர்பார்க்கப்பட்டது ${t.origin ?? "மதிப்பு"} ${r}${t.maximum.toString()} ${a.unit ?? "உறுப்புகள்"} ஆக இருக்க வேண்டும்` : `மிக பெரியது: எதிர்பார்க்கப்பட்டது ${t.origin ?? "மதிப்பு"} ${r}${t.maximum.toString()} ஆக இருக்க வேண்டும்`;
			}
			case "too_small": {
				const r = t.inclusive ? ">=" : ">", a = n(t.origin);
				return a ? `மிகச் சிறியது: எதிர்பார்க்கப்பட்டது ${t.origin} ${r}${t.minimum.toString()} ${a.unit} ஆக இருக்க வேண்டும்` : `மிகச் சிறியது: எதிர்பார்க்கப்பட்டது ${t.origin} ${r}${t.minimum.toString()} ஆக இருக்க வேண்டும்`;
			}
			case "invalid_format": {
				const r = t;
				return r.format === "starts_with" ? `தவறான சரம்: "${r.prefix}" இல் தொடங்க வேண்டும்` : r.format === "ends_with" ? `தவறான சரம்: "${r.suffix}" இல் முடிவடைய வேண்டும்` : r.format === "includes" ? `தவறான சரம்: "${r.includes}" ஐ உள்ளடக்க வேண்டும்` : r.format === "regex" ? `தவறான சரம்: ${r.pattern} முறைபாட்டுடன் பொருந்த வேண்டும்` : `தவறான ${i[r.format] ?? t.format}`;
			}
			case "not_multiple_of": return `தவறான எண்: ${t.divisor} இன் பலமாக இருக்க வேண்டும்`;
			case "unrecognized_keys": return `அடையாளம் தெரியாத விசை${t.keys.length > 1 ? "கள்" : ""}: ${v(t.keys, ", ")}`;
			case "invalid_key": return `${t.origin} இல் தவறான விசை`;
			case "invalid_union": return "தவறான உள்ளீடு";
			case "invalid_element": return `${t.origin} இல் தவறான மதிப்பு`;
			default: return "தவறான உள்ளீடு";
		}
	};
};
function Ff() {
	return { localeError: Lf() };
}
const Jf = () => {
	const e = {
		string: {
			unit: "ตัวอักษร",
			verb: "ควรมี"
		},
		file: {
			unit: "ไบต์",
			verb: "ควรมี"
		},
		array: {
			unit: "รายการ",
			verb: "ควรมี"
		},
		set: {
			unit: "รายการ",
			verb: "ควรมี"
		}
	};
	function n(t) {
		return e[t] ?? null;
	}
	const i = {
		regex: "ข้อมูลที่ป้อน",
		email: "ที่อยู่อีเมล",
		url: "URL",
		emoji: "อิโมจิ",
		uuid: "UUID",
		uuidv4: "UUIDv4",
		uuidv6: "UUIDv6",
		nanoid: "nanoid",
		guid: "GUID",
		cuid: "cuid",
		cuid2: "cuid2",
		ulid: "ULID",
		xid: "XID",
		ksuid: "KSUID",
		datetime: "วันที่เวลาแบบ ISO",
		date: "วันที่แบบ ISO",
		time: "เวลาแบบ ISO",
		duration: "ช่วงเวลาแบบ ISO",
		ipv4: "ที่อยู่ IPv4",
		ipv6: "ที่อยู่ IPv6",
		cidrv4: "ช่วง IP แบบ IPv4",
		cidrv6: "ช่วง IP แบบ IPv6",
		base64: "ข้อความแบบ Base64",
		base64url: "ข้อความแบบ Base64 สำหรับ URL",
		json_string: "ข้อความแบบ JSON",
		e164: "เบอร์โทรศัพท์ระหว่างประเทศ (E.164)",
		jwt: "โทเคน JWT",
		template_literal: "ข้อมูลที่ป้อน"
	}, o = {
		nan: "NaN",
		number: "ตัวเลข",
		array: "อาร์เรย์ (Array)",
		null: "ไม่มีค่า (null)"
	};
	return (t) => {
		switch (t.code) {
			case "invalid_type": {
				const r = o[t.expected] ?? t.expected, a = b(t.input), u = o[a] ?? a;
				return /^[A-Z]/.test(t.expected) ? `ประเภทข้อมูลไม่ถูกต้อง: ควรเป็น instanceof ${t.expected} แต่ได้รับ ${u}` : `ประเภทข้อมูลไม่ถูกต้อง: ควรเป็น ${r} แต่ได้รับ ${u}`;
			}
			case "invalid_value": return t.values.length === 1 ? `ค่าไม่ถูกต้อง: ควรเป็น ${_(t.values[0])}` : `ตัวเลือกไม่ถูกต้อง: ควรเป็นหนึ่งใน ${v(t.values, "|")}`;
			case "too_big": {
				const r = t.inclusive ? "ไม่เกิน" : "น้อยกว่า", a = n(t.origin);
				return a ? `เกินกำหนด: ${t.origin ?? "ค่า"} ควรมี${r} ${t.maximum.toString()} ${a.unit ?? "รายการ"}` : `เกินกำหนด: ${t.origin ?? "ค่า"} ควรมี${r} ${t.maximum.toString()}`;
			}
			case "too_small": {
				const r = t.inclusive ? "อย่างน้อย" : "มากกว่า", a = n(t.origin);
				return a ? `น้อยกว่ากำหนด: ${t.origin} ควรมี${r} ${t.minimum.toString()} ${a.unit}` : `น้อยกว่ากำหนด: ${t.origin} ควรมี${r} ${t.minimum.toString()}`;
			}
			case "invalid_format": {
				const r = t;
				return r.format === "starts_with" ? `รูปแบบไม่ถูกต้อง: ข้อความต้องขึ้นต้นด้วย "${r.prefix}"` : r.format === "ends_with" ? `รูปแบบไม่ถูกต้อง: ข้อความต้องลงท้ายด้วย "${r.suffix}"` : r.format === "includes" ? `รูปแบบไม่ถูกต้อง: ข้อความต้องมี "${r.includes}" อยู่ในข้อความ` : r.format === "regex" ? `รูปแบบไม่ถูกต้อง: ต้องตรงกับรูปแบบที่กำหนด ${r.pattern}` : `รูปแบบไม่ถูกต้อง: ${i[r.format] ?? t.format}`;
			}
			case "not_multiple_of": return `ตัวเลขไม่ถูกต้อง: ต้องเป็นจำนวนที่หารด้วย ${t.divisor} ได้ลงตัว`;
			case "unrecognized_keys": return `พบคีย์ที่ไม่รู้จัก: ${v(t.keys, ", ")}`;
			case "invalid_key": return `คีย์ไม่ถูกต้องใน ${t.origin}`;
			case "invalid_union": return "ข้อมูลไม่ถูกต้อง: ไม่ตรงกับรูปแบบยูเนียนที่กำหนดไว้";
			case "invalid_element": return `ข้อมูลไม่ถูกต้องใน ${t.origin}`;
			default: return "ข้อมูลไม่ถูกต้อง";
		}
	};
};
function Mf() {
	return { localeError: Jf() };
}
const Kf = () => {
	const e = {
		string: {
			unit: "karakter",
			verb: "olmalı"
		},
		file: {
			unit: "bayt",
			verb: "olmalı"
		},
		array: {
			unit: "öğe",
			verb: "olmalı"
		},
		set: {
			unit: "öğe",
			verb: "olmalı"
		}
	};
	function n(t) {
		return e[t] ?? null;
	}
	const i = {
		regex: "girdi",
		email: "e-posta adresi",
		url: "URL",
		emoji: "emoji",
		uuid: "UUID",
		uuidv4: "UUIDv4",
		uuidv6: "UUIDv6",
		nanoid: "nanoid",
		guid: "GUID",
		cuid: "cuid",
		cuid2: "cuid2",
		ulid: "ULID",
		xid: "XID",
		ksuid: "KSUID",
		datetime: "ISO tarih ve saat",
		date: "ISO tarih",
		time: "ISO saat",
		duration: "ISO süre",
		ipv4: "IPv4 adresi",
		ipv6: "IPv6 adresi",
		cidrv4: "IPv4 aralığı",
		cidrv6: "IPv6 aralığı",
		base64: "base64 ile şifrelenmiş metin",
		base64url: "base64url ile şifrelenmiş metin",
		json_string: "JSON dizesi",
		e164: "E.164 sayısı",
		jwt: "JWT",
		template_literal: "Şablon dizesi"
	}, o = { nan: "NaN" };
	return (t) => {
		switch (t.code) {
			case "invalid_type": {
				const r = o[t.expected] ?? t.expected, a = b(t.input), u = o[a] ?? a;
				return /^[A-Z]/.test(t.expected) ? `Geçersiz değer: beklenen instanceof ${t.expected}, alınan ${u}` : `Geçersiz değer: beklenen ${r}, alınan ${u}`;
			}
			case "invalid_value": return t.values.length === 1 ? `Geçersiz değer: beklenen ${_(t.values[0])}` : `Geçersiz seçenek: aşağıdakilerden biri olmalı: ${v(t.values, "|")}`;
			case "too_big": {
				const r = t.inclusive ? "<=" : "<", a = n(t.origin);
				return a ? `Çok büyük: beklenen ${t.origin ?? "değer"} ${r}${t.maximum.toString()} ${a.unit ?? "öğe"}` : `Çok büyük: beklenen ${t.origin ?? "değer"} ${r}${t.maximum.toString()}`;
			}
			case "too_small": {
				const r = t.inclusive ? ">=" : ">", a = n(t.origin);
				return a ? `Çok küçük: beklenen ${t.origin} ${r}${t.minimum.toString()} ${a.unit}` : `Çok küçük: beklenen ${t.origin} ${r}${t.minimum.toString()}`;
			}
			case "invalid_format": {
				const r = t;
				return r.format === "starts_with" ? `Geçersiz metin: "${r.prefix}" ile başlamalı` : r.format === "ends_with" ? `Geçersiz metin: "${r.suffix}" ile bitmeli` : r.format === "includes" ? `Geçersiz metin: "${r.includes}" içermeli` : r.format === "regex" ? `Geçersiz metin: ${r.pattern} desenine uymalı` : `Geçersiz ${i[r.format] ?? t.format}`;
			}
			case "not_multiple_of": return `Geçersiz sayı: ${t.divisor} ile tam bölünebilmeli`;
			case "unrecognized_keys": return `Tanınmayan anahtar${t.keys.length > 1 ? "lar" : ""}: ${v(t.keys, ", ")}`;
			case "invalid_key": return `${t.origin} içinde geçersiz anahtar`;
			case "invalid_union": return "Geçersiz değer";
			case "invalid_element": return `${t.origin} içinde geçersiz değer`;
			default: return "Geçersiz değer";
		}
	};
};
function Gf() {
	return { localeError: Kf() };
}
const Vf = () => {
	const e = {
		string: {
			unit: "символів",
			verb: "матиме"
		},
		file: {
			unit: "байтів",
			verb: "матиме"
		},
		array: {
			unit: "елементів",
			verb: "матиме"
		},
		set: {
			unit: "елементів",
			verb: "матиме"
		}
	};
	function n(t) {
		return e[t] ?? null;
	}
	const i = {
		regex: "вхідні дані",
		email: "адреса електронної пошти",
		url: "URL",
		emoji: "емодзі",
		uuid: "UUID",
		uuidv4: "UUIDv4",
		uuidv6: "UUIDv6",
		nanoid: "nanoid",
		guid: "GUID",
		cuid: "cuid",
		cuid2: "cuid2",
		ulid: "ULID",
		xid: "XID",
		ksuid: "KSUID",
		datetime: "дата та час ISO",
		date: "дата ISO",
		time: "час ISO",
		duration: "тривалість ISO",
		ipv4: "адреса IPv4",
		ipv6: "адреса IPv6",
		cidrv4: "діапазон IPv4",
		cidrv6: "діапазон IPv6",
		base64: "рядок у кодуванні base64",
		base64url: "рядок у кодуванні base64url",
		json_string: "рядок JSON",
		e164: "номер E.164",
		jwt: "JWT",
		template_literal: "вхідні дані"
	}, o = {
		nan: "NaN",
		number: "число",
		array: "масив"
	};
	return (t) => {
		switch (t.code) {
			case "invalid_type": {
				const r = o[t.expected] ?? t.expected, a = b(t.input), u = o[a] ?? a;
				return /^[A-Z]/.test(t.expected) ? `Неправильні вхідні дані: очікується instanceof ${t.expected}, отримано ${u}` : `Неправильні вхідні дані: очікується ${r}, отримано ${u}`;
			}
			case "invalid_value": return t.values.length === 1 ? `Неправильні вхідні дані: очікується ${_(t.values[0])}` : `Неправильна опція: очікується одне з ${v(t.values, "|")}`;
			case "too_big": {
				const r = t.inclusive ? "<=" : "<", a = n(t.origin);
				return a ? `Занадто велике: очікується, що ${t.origin ?? "значення"} ${a.verb} ${r}${t.maximum.toString()} ${a.unit ?? "елементів"}` : `Занадто велике: очікується, що ${t.origin ?? "значення"} буде ${r}${t.maximum.toString()}`;
			}
			case "too_small": {
				const r = t.inclusive ? ">=" : ">", a = n(t.origin);
				return a ? `Занадто мале: очікується, що ${t.origin} ${a.verb} ${r}${t.minimum.toString()} ${a.unit}` : `Занадто мале: очікується, що ${t.origin} буде ${r}${t.minimum.toString()}`;
			}
			case "invalid_format": {
				const r = t;
				return r.format === "starts_with" ? `Неправильний рядок: повинен починатися з "${r.prefix}"` : r.format === "ends_with" ? `Неправильний рядок: повинен закінчуватися на "${r.suffix}"` : r.format === "includes" ? `Неправильний рядок: повинен містити "${r.includes}"` : r.format === "regex" ? `Неправильний рядок: повинен відповідати шаблону ${r.pattern}` : `Неправильний ${i[r.format] ?? t.format}`;
			}
			case "not_multiple_of": return `Неправильне число: повинно бути кратним ${t.divisor}`;
			case "unrecognized_keys": return `Нерозпізнаний ключ${t.keys.length > 1 ? "і" : ""}: ${v(t.keys, ", ")}`;
			case "invalid_key": return `Неправильний ключ у ${t.origin}`;
			case "invalid_union": return "Неправильні вхідні дані";
			case "invalid_element": return `Неправильне значення у ${t.origin}`;
			default: return "Неправильні вхідні дані";
		}
	};
};
function ec() {
	return { localeError: Vf() };
}
function Bf() {
	return ec();
}
const Wf = () => {
	const e = {
		string: {
			unit: "حروف",
			verb: "ہونا"
		},
		file: {
			unit: "بائٹس",
			verb: "ہونا"
		},
		array: {
			unit: "آئٹمز",
			verb: "ہونا"
		},
		set: {
			unit: "آئٹمز",
			verb: "ہونا"
		}
	};
	function n(t) {
		return e[t] ?? null;
	}
	const i = {
		regex: "ان پٹ",
		email: "ای میل ایڈریس",
		url: "یو آر ایل",
		emoji: "ایموجی",
		uuid: "یو یو آئی ڈی",
		uuidv4: "یو یو آئی ڈی وی 4",
		uuidv6: "یو یو آئی ڈی وی 6",
		nanoid: "نینو آئی ڈی",
		guid: "جی یو آئی ڈی",
		cuid: "سی یو آئی ڈی",
		cuid2: "سی یو آئی ڈی 2",
		ulid: "یو ایل آئی ڈی",
		xid: "ایکس آئی ڈی",
		ksuid: "کے ایس یو آئی ڈی",
		datetime: "آئی ایس او ڈیٹ ٹائم",
		date: "آئی ایس او تاریخ",
		time: "آئی ایس او وقت",
		duration: "آئی ایس او مدت",
		ipv4: "آئی پی وی 4 ایڈریس",
		ipv6: "آئی پی وی 6 ایڈریس",
		cidrv4: "آئی پی وی 4 رینج",
		cidrv6: "آئی پی وی 6 رینج",
		base64: "بیس 64 ان کوڈڈ سٹرنگ",
		base64url: "بیس 64 یو آر ایل ان کوڈڈ سٹرنگ",
		json_string: "جے ایس او این سٹرنگ",
		e164: "ای 164 نمبر",
		jwt: "جے ڈبلیو ٹی",
		template_literal: "ان پٹ"
	}, o = {
		nan: "NaN",
		number: "نمبر",
		array: "آرے",
		null: "نل"
	};
	return (t) => {
		switch (t.code) {
			case "invalid_type": {
				const r = o[t.expected] ?? t.expected, a = b(t.input), u = o[a] ?? a;
				return /^[A-Z]/.test(t.expected) ? `غلط ان پٹ: instanceof ${t.expected} متوقع تھا، ${u} موصول ہوا` : `غلط ان پٹ: ${r} متوقع تھا، ${u} موصول ہوا`;
			}
			case "invalid_value": return t.values.length === 1 ? `غلط ان پٹ: ${_(t.values[0])} متوقع تھا` : `غلط آپشن: ${v(t.values, "|")} میں سے ایک متوقع تھا`;
			case "too_big": {
				const r = t.inclusive ? "<=" : "<", a = n(t.origin);
				return a ? `بہت بڑا: ${t.origin ?? "ویلیو"} کے ${r}${t.maximum.toString()} ${a.unit ?? "عناصر"} ہونے متوقع تھے` : `بہت بڑا: ${t.origin ?? "ویلیو"} کا ${r}${t.maximum.toString()} ہونا متوقع تھا`;
			}
			case "too_small": {
				const r = t.inclusive ? ">=" : ">", a = n(t.origin);
				return a ? `بہت چھوٹا: ${t.origin} کے ${r}${t.minimum.toString()} ${a.unit} ہونے متوقع تھے` : `بہت چھوٹا: ${t.origin} کا ${r}${t.minimum.toString()} ہونا متوقع تھا`;
			}
			case "invalid_format": {
				const r = t;
				return r.format === "starts_with" ? `غلط سٹرنگ: "${r.prefix}" سے شروع ہونا چاہیے` : r.format === "ends_with" ? `غلط سٹرنگ: "${r.suffix}" پر ختم ہونا چاہیے` : r.format === "includes" ? `غلط سٹرنگ: "${r.includes}" شامل ہونا چاہیے` : r.format === "regex" ? `غلط سٹرنگ: پیٹرن ${r.pattern} سے میچ ہونا چاہیے` : `غلط ${i[r.format] ?? t.format}`;
			}
			case "not_multiple_of": return `غلط نمبر: ${t.divisor} کا مضاعف ہونا چاہیے`;
			case "unrecognized_keys": return `غیر تسلیم شدہ کی${t.keys.length > 1 ? "ز" : ""}: ${v(t.keys, "، ")}`;
			case "invalid_key": return `${t.origin} میں غلط کی`;
			case "invalid_union": return "غلط ان پٹ";
			case "invalid_element": return `${t.origin} میں غلط ویلیو`;
			default: return "غلط ان پٹ";
		}
	};
};
function Xf() {
	return { localeError: Wf() };
}
const qf = () => {
	const e = {
		string: {
			unit: "belgi",
			verb: "bo‘lishi kerak"
		},
		file: {
			unit: "bayt",
			verb: "bo‘lishi kerak"
		},
		array: {
			unit: "element",
			verb: "bo‘lishi kerak"
		},
		set: {
			unit: "element",
			verb: "bo‘lishi kerak"
		},
		map: {
			unit: "yozuv",
			verb: "bo‘lishi kerak"
		}
	};
	function n(t) {
		return e[t] ?? null;
	}
	const i = {
		regex: "kirish",
		email: "elektron pochta manzili",
		url: "URL",
		emoji: "emoji",
		uuid: "UUID",
		uuidv4: "UUIDv4",
		uuidv6: "UUIDv6",
		nanoid: "nanoid",
		guid: "GUID",
		cuid: "cuid",
		cuid2: "cuid2",
		ulid: "ULID",
		xid: "XID",
		ksuid: "KSUID",
		datetime: "ISO sana va vaqti",
		date: "ISO sana",
		time: "ISO vaqt",
		duration: "ISO davomiylik",
		ipv4: "IPv4 manzil",
		ipv6: "IPv6 manzil",
		mac: "MAC manzil",
		cidrv4: "IPv4 diapazon",
		cidrv6: "IPv6 diapazon",
		base64: "base64 kodlangan satr",
		base64url: "base64url kodlangan satr",
		json_string: "JSON satr",
		e164: "E.164 raqam",
		jwt: "JWT",
		template_literal: "kirish"
	}, o = {
		nan: "NaN",
		number: "raqam",
		array: "massiv"
	};
	return (t) => {
		switch (t.code) {
			case "invalid_type": {
				const r = o[t.expected] ?? t.expected, a = b(t.input), u = o[a] ?? a;
				return /^[A-Z]/.test(t.expected) ? `Noto‘g‘ri kirish: kutilgan instanceof ${t.expected}, qabul qilingan ${u}` : `Noto‘g‘ri kirish: kutilgan ${r}, qabul qilingan ${u}`;
			}
			case "invalid_value": return t.values.length === 1 ? `Noto‘g‘ri kirish: kutilgan ${_(t.values[0])}` : `Noto‘g‘ri variant: quyidagilardan biri kutilgan ${v(t.values, "|")}`;
			case "too_big": {
				const r = t.inclusive ? "<=" : "<", a = n(t.origin);
				return a ? `Juda katta: kutilgan ${t.origin ?? "qiymat"} ${r}${t.maximum.toString()} ${a.unit} ${a.verb}` : `Juda katta: kutilgan ${t.origin ?? "qiymat"} ${r}${t.maximum.toString()}`;
			}
			case "too_small": {
				const r = t.inclusive ? ">=" : ">", a = n(t.origin);
				return a ? `Juda kichik: kutilgan ${t.origin} ${r}${t.minimum.toString()} ${a.unit} ${a.verb}` : `Juda kichik: kutilgan ${t.origin} ${r}${t.minimum.toString()}`;
			}
			case "invalid_format": {
				const r = t;
				return r.format === "starts_with" ? `Noto‘g‘ri satr: "${r.prefix}" bilan boshlanishi kerak` : r.format === "ends_with" ? `Noto‘g‘ri satr: "${r.suffix}" bilan tugashi kerak` : r.format === "includes" ? `Noto‘g‘ri satr: "${r.includes}" ni o‘z ichiga olishi kerak` : r.format === "regex" ? `Noto‘g‘ri satr: ${r.pattern} shabloniga mos kelishi kerak` : `Noto‘g‘ri ${i[r.format] ?? t.format}`;
			}
			case "not_multiple_of": return `Noto‘g‘ri raqam: ${t.divisor} ning karralisi bo‘lishi kerak`;
			case "unrecognized_keys": return `Noma’lum kalit${t.keys.length > 1 ? "lar" : ""}: ${v(t.keys, ", ")}`;
			case "invalid_key": return `${t.origin} dagi kalit noto‘g‘ri`;
			case "invalid_union": return "Noto‘g‘ri kirish";
			case "invalid_element": return `${t.origin} da noto‘g‘ri qiymat`;
			default: return "Noto‘g‘ri kirish";
		}
	};
};
function Yf() {
	return { localeError: qf() };
}
const Hf = () => {
	const e = {
		string: {
			unit: "ký tự",
			verb: "có"
		},
		file: {
			unit: "byte",
			verb: "có"
		},
		array: {
			unit: "phần tử",
			verb: "có"
		},
		set: {
			unit: "phần tử",
			verb: "có"
		}
	};
	function n(t) {
		return e[t] ?? null;
	}
	const i = {
		regex: "đầu vào",
		email: "địa chỉ email",
		url: "URL",
		emoji: "emoji",
		uuid: "UUID",
		uuidv4: "UUIDv4",
		uuidv6: "UUIDv6",
		nanoid: "nanoid",
		guid: "GUID",
		cuid: "cuid",
		cuid2: "cuid2",
		ulid: "ULID",
		xid: "XID",
		ksuid: "KSUID",
		datetime: "ngày giờ ISO",
		date: "ngày ISO",
		time: "giờ ISO",
		duration: "khoảng thời gian ISO",
		ipv4: "địa chỉ IPv4",
		ipv6: "địa chỉ IPv6",
		cidrv4: "dải IPv4",
		cidrv6: "dải IPv6",
		base64: "chuỗi mã hóa base64",
		base64url: "chuỗi mã hóa base64url",
		json_string: "chuỗi JSON",
		e164: "số E.164",
		jwt: "JWT",
		template_literal: "đầu vào"
	}, o = {
		nan: "NaN",
		number: "số",
		array: "mảng"
	};
	return (t) => {
		switch (t.code) {
			case "invalid_type": {
				const r = o[t.expected] ?? t.expected, a = b(t.input), u = o[a] ?? a;
				return /^[A-Z]/.test(t.expected) ? `Đầu vào không hợp lệ: mong đợi instanceof ${t.expected}, nhận được ${u}` : `Đầu vào không hợp lệ: mong đợi ${r}, nhận được ${u}`;
			}
			case "invalid_value": return t.values.length === 1 ? `Đầu vào không hợp lệ: mong đợi ${_(t.values[0])}` : `Tùy chọn không hợp lệ: mong đợi một trong các giá trị ${v(t.values, "|")}`;
			case "too_big": {
				const r = t.inclusive ? "<=" : "<", a = n(t.origin);
				return a ? `Quá lớn: mong đợi ${t.origin ?? "giá trị"} ${a.verb} ${r}${t.maximum.toString()} ${a.unit ?? "phần tử"}` : `Quá lớn: mong đợi ${t.origin ?? "giá trị"} ${r}${t.maximum.toString()}`;
			}
			case "too_small": {
				const r = t.inclusive ? ">=" : ">", a = n(t.origin);
				return a ? `Quá nhỏ: mong đợi ${t.origin} ${a.verb} ${r}${t.minimum.toString()} ${a.unit}` : `Quá nhỏ: mong đợi ${t.origin} ${r}${t.minimum.toString()}`;
			}
			case "invalid_format": {
				const r = t;
				return r.format === "starts_with" ? `Chuỗi không hợp lệ: phải bắt đầu bằng "${r.prefix}"` : r.format === "ends_with" ? `Chuỗi không hợp lệ: phải kết thúc bằng "${r.suffix}"` : r.format === "includes" ? `Chuỗi không hợp lệ: phải bao gồm "${r.includes}"` : r.format === "regex" ? `Chuỗi không hợp lệ: phải khớp với mẫu ${r.pattern}` : `${i[r.format] ?? t.format} không hợp lệ`;
			}
			case "not_multiple_of": return `Số không hợp lệ: phải là bội số của ${t.divisor}`;
			case "unrecognized_keys": return `Khóa không được nhận dạng: ${v(t.keys, ", ")}`;
			case "invalid_key": return `Khóa không hợp lệ trong ${t.origin}`;
			case "invalid_union": return "Đầu vào không hợp lệ";
			case "invalid_element": return `Giá trị không hợp lệ trong ${t.origin}`;
			default: return "Đầu vào không hợp lệ";
		}
	};
};
function Qf() {
	return { localeError: Hf() };
}
const ep = () => {
	const e = {
		string: {
			unit: "字符",
			verb: "包含"
		},
		file: {
			unit: "字节",
			verb: "包含"
		},
		array: {
			unit: "项",
			verb: "包含"
		},
		set: {
			unit: "项",
			verb: "包含"
		}
	};
	function n(t) {
		return e[t] ?? null;
	}
	const i = {
		regex: "输入",
		email: "电子邮件",
		url: "URL",
		emoji: "表情符号",
		uuid: "UUID",
		uuidv4: "UUIDv4",
		uuidv6: "UUIDv6",
		nanoid: "nanoid",
		guid: "GUID",
		cuid: "cuid",
		cuid2: "cuid2",
		ulid: "ULID",
		xid: "XID",
		ksuid: "KSUID",
		datetime: "ISO日期时间",
		date: "ISO日期",
		time: "ISO时间",
		duration: "ISO时长",
		ipv4: "IPv4地址",
		ipv6: "IPv6地址",
		cidrv4: "IPv4网段",
		cidrv6: "IPv6网段",
		base64: "base64编码字符串",
		base64url: "base64url编码字符串",
		json_string: "JSON字符串",
		e164: "E.164号码",
		jwt: "JWT",
		template_literal: "输入"
	}, o = {
		nan: "NaN",
		number: "数字",
		array: "数组",
		null: "空值(null)"
	};
	return (t) => {
		switch (t.code) {
			case "invalid_type": {
				const r = o[t.expected] ?? t.expected, a = b(t.input), u = o[a] ?? a;
				return /^[A-Z]/.test(t.expected) ? `无效输入：期望 instanceof ${t.expected}，实际接收 ${u}` : `无效输入：期望 ${r}，实际接收 ${u}`;
			}
			case "invalid_value": return t.values.length === 1 ? `无效输入：期望 ${_(t.values[0])}` : `无效选项：期望以下之一 ${v(t.values, "|")}`;
			case "too_big": {
				const r = t.inclusive ? "<=" : "<", a = n(t.origin);
				return a ? `数值过大：期望 ${t.origin ?? "值"} ${r}${t.maximum.toString()} ${a.unit ?? "个元素"}` : `数值过大：期望 ${t.origin ?? "值"} ${r}${t.maximum.toString()}`;
			}
			case "too_small": {
				const r = t.inclusive ? ">=" : ">", a = n(t.origin);
				return a ? `数值过小：期望 ${t.origin} ${r}${t.minimum.toString()} ${a.unit}` : `数值过小：期望 ${t.origin} ${r}${t.minimum.toString()}`;
			}
			case "invalid_format": {
				const r = t;
				return r.format === "starts_with" ? `无效字符串：必须以 "${r.prefix}" 开头` : r.format === "ends_with" ? `无效字符串：必须以 "${r.suffix}" 结尾` : r.format === "includes" ? `无效字符串：必须包含 "${r.includes}"` : r.format === "regex" ? `无效字符串：必须满足正则表达式 ${r.pattern}` : `无效${i[r.format] ?? t.format}`;
			}
			case "not_multiple_of": return `无效数字：必须是 ${t.divisor} 的倍数`;
			case "unrecognized_keys": return `出现未知的键(key): ${v(t.keys, ", ")}`;
			case "invalid_key": return `${t.origin} 中的键(key)无效`;
			case "invalid_union": return "无效输入";
			case "invalid_element": return `${t.origin} 中包含无效值(value)`;
			default: return "无效输入";
		}
	};
};
function tp() {
	return { localeError: ep() };
}
const np = () => {
	const e = {
		string: {
			unit: "字元",
			verb: "擁有"
		},
		file: {
			unit: "位元組",
			verb: "擁有"
		},
		array: {
			unit: "項目",
			verb: "擁有"
		},
		set: {
			unit: "項目",
			verb: "擁有"
		}
	};
	function n(t) {
		return e[t] ?? null;
	}
	const i = {
		regex: "輸入",
		email: "郵件地址",
		url: "URL",
		emoji: "emoji",
		uuid: "UUID",
		uuidv4: "UUIDv4",
		uuidv6: "UUIDv6",
		nanoid: "nanoid",
		guid: "GUID",
		cuid: "cuid",
		cuid2: "cuid2",
		ulid: "ULID",
		xid: "XID",
		ksuid: "KSUID",
		datetime: "ISO 日期時間",
		date: "ISO 日期",
		time: "ISO 時間",
		duration: "ISO 期間",
		ipv4: "IPv4 位址",
		ipv6: "IPv6 位址",
		cidrv4: "IPv4 範圍",
		cidrv6: "IPv6 範圍",
		base64: "base64 編碼字串",
		base64url: "base64url 編碼字串",
		json_string: "JSON 字串",
		e164: "E.164 數值",
		jwt: "JWT",
		template_literal: "輸入"
	}, o = { nan: "NaN" };
	return (t) => {
		switch (t.code) {
			case "invalid_type": {
				const r = o[t.expected] ?? t.expected, a = b(t.input), u = o[a] ?? a;
				return /^[A-Z]/.test(t.expected) ? `無效的輸入值：預期為 instanceof ${t.expected}，但收到 ${u}` : `無效的輸入值：預期為 ${r}，但收到 ${u}`;
			}
			case "invalid_value": return t.values.length === 1 ? `無效的輸入值：預期為 ${_(t.values[0])}` : `無效的選項：預期為以下其中之一 ${v(t.values, "|")}`;
			case "too_big": {
				const r = t.inclusive ? "<=" : "<", a = n(t.origin);
				return a ? `數值過大：預期 ${t.origin ?? "值"} 應為 ${r}${t.maximum.toString()} ${a.unit ?? "個元素"}` : `數值過大：預期 ${t.origin ?? "值"} 應為 ${r}${t.maximum.toString()}`;
			}
			case "too_small": {
				const r = t.inclusive ? ">=" : ">", a = n(t.origin);
				return a ? `數值過小：預期 ${t.origin} 應為 ${r}${t.minimum.toString()} ${a.unit}` : `數值過小：預期 ${t.origin} 應為 ${r}${t.minimum.toString()}`;
			}
			case "invalid_format": {
				const r = t;
				return r.format === "starts_with" ? `無效的字串：必須以 "${r.prefix}" 開頭` : r.format === "ends_with" ? `無效的字串：必須以 "${r.suffix}" 結尾` : r.format === "includes" ? `無效的字串：必須包含 "${r.includes}"` : r.format === "regex" ? `無效的字串：必須符合格式 ${r.pattern}` : `無效的 ${i[r.format] ?? t.format}`;
			}
			case "not_multiple_of": return `無效的數字：必須為 ${t.divisor} 的倍數`;
			case "unrecognized_keys": return `無法識別的鍵值${t.keys.length > 1 ? "們" : ""}：${v(t.keys, "、")}`;
			case "invalid_key": return `${t.origin} 中有無效的鍵值`;
			case "invalid_union": return "無效的輸入值";
			case "invalid_element": return `${t.origin} 中有無效的值`;
			default: return "無效的輸入值";
		}
	};
};
function rp() {
	return { localeError: np() };
}
const ip = () => {
	const e = {
		string: {
			unit: "àmi",
			verb: "ní"
		},
		file: {
			unit: "bytes",
			verb: "ní"
		},
		array: {
			unit: "nkan",
			verb: "ní"
		},
		set: {
			unit: "nkan",
			verb: "ní"
		}
	};
	function n(t) {
		return e[t] ?? null;
	}
	const i = {
		regex: "ẹ̀rọ ìbáwọlé",
		email: "àdírẹ́sì ìmẹ́lì",
		url: "URL",
		emoji: "emoji",
		uuid: "UUID",
		uuidv4: "UUIDv4",
		uuidv6: "UUIDv6",
		nanoid: "nanoid",
		guid: "GUID",
		cuid: "cuid",
		cuid2: "cuid2",
		ulid: "ULID",
		xid: "XID",
		ksuid: "KSUID",
		datetime: "àkókò ISO",
		date: "ọjọ́ ISO",
		time: "àkókò ISO",
		duration: "àkókò tó pé ISO",
		ipv4: "àdírẹ́sì IPv4",
		ipv6: "àdírẹ́sì IPv6",
		cidrv4: "àgbègbè IPv4",
		cidrv6: "àgbègbè IPv6",
		base64: "ọ̀rọ̀ tí a kọ́ ní base64",
		base64url: "ọ̀rọ̀ base64url",
		json_string: "ọ̀rọ̀ JSON",
		e164: "nọ́mbà E.164",
		jwt: "JWT",
		template_literal: "ẹ̀rọ ìbáwọlé"
	}, o = {
		nan: "NaN",
		number: "nọ́mbà",
		array: "akopọ"
	};
	return (t) => {
		switch (t.code) {
			case "invalid_type": {
				const r = o[t.expected] ?? t.expected, a = b(t.input), u = o[a] ?? a;
				return /^[A-Z]/.test(t.expected) ? `Ìbáwọlé aṣìṣe: a ní láti fi instanceof ${t.expected}, àmọ̀ a rí ${u}` : `Ìbáwọlé aṣìṣe: a ní láti fi ${r}, àmọ̀ a rí ${u}`;
			}
			case "invalid_value": return t.values.length === 1 ? `Ìbáwọlé aṣìṣe: a ní láti fi ${_(t.values[0])}` : `Àṣàyàn aṣìṣe: yan ọ̀kan lára ${v(t.values, "|")}`;
			case "too_big": {
				const r = t.inclusive ? "<=" : "<", a = n(t.origin);
				return a ? `Tó pọ̀ jù: a ní láti jẹ́ pé ${t.origin ?? "iye"} ${a.verb} ${r}${t.maximum} ${a.unit}` : `Tó pọ̀ jù: a ní láti jẹ́ ${r}${t.maximum}`;
			}
			case "too_small": {
				const r = t.inclusive ? ">=" : ">", a = n(t.origin);
				return a ? `Kéré ju: a ní láti jẹ́ pé ${t.origin} ${a.verb} ${r}${t.minimum} ${a.unit}` : `Kéré ju: a ní láti jẹ́ ${r}${t.minimum}`;
			}
			case "invalid_format": {
				const r = t;
				return r.format === "starts_with" ? `Ọ̀rọ̀ aṣìṣe: gbọ́dọ̀ bẹ̀rẹ̀ pẹ̀lú "${r.prefix}"` : r.format === "ends_with" ? `Ọ̀rọ̀ aṣìṣe: gbọ́dọ̀ parí pẹ̀lú "${r.suffix}"` : r.format === "includes" ? `Ọ̀rọ̀ aṣìṣe: gbọ́dọ̀ ní "${r.includes}"` : r.format === "regex" ? `Ọ̀rọ̀ aṣìṣe: gbọ́dọ̀ bá àpẹẹrẹ mu ${r.pattern}` : `Aṣìṣe: ${i[r.format] ?? t.format}`;
			}
			case "not_multiple_of": return `Nọ́mbà aṣìṣe: gbọ́dọ̀ jẹ́ èyà pípín ti ${t.divisor}`;
			case "unrecognized_keys": return `Bọtìnì àìmọ̀: ${v(t.keys, ", ")}`;
			case "invalid_key": return `Bọtìnì aṣìṣe nínú ${t.origin}`;
			case "invalid_union": return "Ìbáwọlé aṣìṣe";
			case "invalid_element": return `Iye aṣìṣe nínú ${t.origin}`;
			default: return "Ìbáwọlé aṣìṣe";
		}
	};
};
function op() {
	return { localeError: ip() };
}
var tc = W({
	ar: () => vm,
	az: () => hm,
	be: () => _m,
	bg: () => ym,
	ca: () => Sm,
	cs: () => zm,
	da: () => xm,
	de: () => Um,
	el: () => Dm,
	en: () => Hu,
	eo: () => Pm,
	es: () => Em,
	fa: () => Cm,
	fi: () => Lm,
	fr: () => Jm,
	frCA: () => Km,
	he: () => Vm,
	hr: () => Wm,
	hu: () => qm,
	hy: () => Hm,
	id: () => ef,
	is: () => nf,
	it: () => of,
	ja: () => uf,
	ka: () => lf,
	kh: () => df,
	km: () => Qu,
	ko: () => ff,
	lt: () => vf,
	mk: () => hf,
	ms: () => _f,
	nl: () => yf,
	no: () => Sf,
	ota: () => zf,
	pl: () => Uf,
	ps: () => xf,
	pt: () => Df,
	ro: () => Nf,
	ru: () => Tf,
	sl: () => Af,
	sv: () => Rf,
	ta: () => Ff,
	th: () => Mf,
	tr: () => Gf,
	ua: () => Bf,
	uk: () => ec,
	ur: () => Xf,
	uz: () => Yf,
	vi: () => Qf,
	yo: () => op,
	zhCN: () => tp,
	zhTW: () => rp
}), eo;
const nc = Symbol("ZodOutput"), rc = Symbol("ZodInput");
var ic = class {
	constructor() {
		this._map = /* @__PURE__ */ new WeakMap(), this._idmap = /* @__PURE__ */ new Map();
	}
	add(e, ...n) {
		const i = n[0];
		return this._map.set(e, i), i && typeof i == "object" && "id" in i && this._idmap.set(i.id, e), this;
	}
	clear() {
		return this._map = /* @__PURE__ */ new WeakMap(), this._idmap = /* @__PURE__ */ new Map(), this;
	}
	remove(e) {
		const n = this._map.get(e);
		return n && typeof n == "object" && "id" in n && this._idmap.delete(n.id), this._map.delete(e), this;
	}
	get(e) {
		const n = e._zod.parent;
		if (n) {
			const i = { ...this.get(n) ?? {} };
			delete i.id;
			const o = {
				...i,
				...this._map.get(e)
			};
			return Object.keys(o).length ? o : void 0;
		}
		return this._map.get(e);
	}
	has(e) {
		return this._map.has(e);
	}
};
function ur() {
	return new ic();
}
(eo = globalThis).__zod_globalRegistry ?? (eo.__zod_globalRegistry = ur());
const M = globalThis.__zod_globalRegistry;
function oc(e, n) {
	return new e({
		type: "string",
		...p(n)
	});
}
function ac(e, n) {
	return new e({
		type: "string",
		coerce: !0,
		...p(n)
	});
}
function cr(e, n) {
	return new e({
		type: "string",
		format: "email",
		check: "string_format",
		abort: !1,
		...p(n)
	});
}
function St(e, n) {
	return new e({
		type: "string",
		format: "guid",
		check: "string_format",
		abort: !1,
		...p(n)
	});
}
function lr(e, n) {
	return new e({
		type: "string",
		format: "uuid",
		check: "string_format",
		abort: !1,
		...p(n)
	});
}
function sr(e, n) {
	return new e({
		type: "string",
		format: "uuid",
		check: "string_format",
		abort: !1,
		version: "v4",
		...p(n)
	});
}
function dr(e, n) {
	return new e({
		type: "string",
		format: "uuid",
		check: "string_format",
		abort: !1,
		version: "v6",
		...p(n)
	});
}
function mr(e, n) {
	return new e({
		type: "string",
		format: "uuid",
		check: "string_format",
		abort: !1,
		version: "v7",
		...p(n)
	});
}
function Pt(e, n) {
	return new e({
		type: "string",
		format: "url",
		check: "string_format",
		abort: !1,
		...p(n)
	});
}
function fr(e, n) {
	return new e({
		type: "string",
		format: "emoji",
		check: "string_format",
		abort: !1,
		...p(n)
	});
}
function pr(e, n) {
	return new e({
		type: "string",
		format: "nanoid",
		check: "string_format",
		abort: !1,
		...p(n)
	});
}
function vr(e, n) {
	return new e({
		type: "string",
		format: "cuid",
		check: "string_format",
		abort: !1,
		...p(n)
	});
}
function gr(e, n) {
	return new e({
		type: "string",
		format: "cuid2",
		check: "string_format",
		abort: !1,
		...p(n)
	});
}
function hr(e, n) {
	return new e({
		type: "string",
		format: "ulid",
		check: "string_format",
		abort: !1,
		...p(n)
	});
}
function $r(e, n) {
	return new e({
		type: "string",
		format: "xid",
		check: "string_format",
		abort: !1,
		...p(n)
	});
}
function _r(e, n) {
	return new e({
		type: "string",
		format: "ksuid",
		check: "string_format",
		abort: !1,
		...p(n)
	});
}
function br(e, n) {
	return new e({
		type: "string",
		format: "ipv4",
		check: "string_format",
		abort: !1,
		...p(n)
	});
}
function yr(e, n) {
	return new e({
		type: "string",
		format: "ipv6",
		check: "string_format",
		abort: !1,
		...p(n)
	});
}
function uc(e, n) {
	return new e({
		type: "string",
		format: "mac",
		check: "string_format",
		abort: !1,
		...p(n)
	});
}
function kr(e, n) {
	return new e({
		type: "string",
		format: "cidrv4",
		check: "string_format",
		abort: !1,
		...p(n)
	});
}
function Sr(e, n) {
	return new e({
		type: "string",
		format: "cidrv6",
		check: "string_format",
		abort: !1,
		...p(n)
	});
}
function Ir(e, n) {
	return new e({
		type: "string",
		format: "base64",
		check: "string_format",
		abort: !1,
		...p(n)
	});
}
function zr(e, n) {
	return new e({
		type: "string",
		format: "base64url",
		check: "string_format",
		abort: !1,
		...p(n)
	});
}
function wr(e, n) {
	return new e({
		type: "string",
		format: "e164",
		check: "string_format",
		abort: !1,
		...p(n)
	});
}
function xr(e, n) {
	return new e({
		type: "string",
		format: "jwt",
		check: "string_format",
		abort: !1,
		...p(n)
	});
}
const cc = {
	Any: null,
	Minute: -1,
	Second: 0,
	Millisecond: 3,
	Microsecond: 6
};
function lc(e, n) {
	return new e({
		type: "string",
		format: "datetime",
		check: "string_format",
		offset: !1,
		local: !1,
		precision: null,
		...p(n)
	});
}
function sc(e, n) {
	return new e({
		type: "string",
		format: "date",
		check: "string_format",
		...p(n)
	});
}
function dc(e, n) {
	return new e({
		type: "string",
		format: "time",
		check: "string_format",
		precision: null,
		...p(n)
	});
}
function mc(e, n) {
	return new e({
		type: "string",
		format: "duration",
		check: "string_format",
		...p(n)
	});
}
function fc(e, n) {
	return new e({
		type: "number",
		checks: [],
		...p(n)
	});
}
function pc(e, n) {
	return new e({
		type: "number",
		coerce: !0,
		checks: [],
		...p(n)
	});
}
function vc(e, n) {
	return new e({
		type: "number",
		check: "number_format",
		abort: !1,
		format: "safeint",
		...p(n)
	});
}
function gc(e, n) {
	return new e({
		type: "number",
		check: "number_format",
		abort: !1,
		format: "float32",
		...p(n)
	});
}
function hc(e, n) {
	return new e({
		type: "number",
		check: "number_format",
		abort: !1,
		format: "float64",
		...p(n)
	});
}
function $c(e, n) {
	return new e({
		type: "number",
		check: "number_format",
		abort: !1,
		format: "int32",
		...p(n)
	});
}
function _c(e, n) {
	return new e({
		type: "number",
		check: "number_format",
		abort: !1,
		format: "uint32",
		...p(n)
	});
}
function bc(e, n) {
	return new e({
		type: "boolean",
		...p(n)
	});
}
function yc(e, n) {
	return new e({
		type: "boolean",
		coerce: !0,
		...p(n)
	});
}
function kc(e, n) {
	return new e({
		type: "bigint",
		...p(n)
	});
}
function Sc(e, n) {
	return new e({
		type: "bigint",
		coerce: !0,
		...p(n)
	});
}
function Ic(e, n) {
	return new e({
		type: "bigint",
		check: "bigint_format",
		abort: !1,
		format: "int64",
		...p(n)
	});
}
function zc(e, n) {
	return new e({
		type: "bigint",
		check: "bigint_format",
		abort: !1,
		format: "uint64",
		...p(n)
	});
}
function wc(e, n) {
	return new e({
		type: "symbol",
		...p(n)
	});
}
function xc(e, n) {
	return new e({
		type: "undefined",
		...p(n)
	});
}
function Zc(e, n) {
	return new e({
		type: "null",
		...p(n)
	});
}
function Uc(e) {
	return new e({ type: "any" });
}
function jc(e) {
	return new e({ type: "unknown" });
}
function Dc(e, n) {
	return new e({
		type: "never",
		...p(n)
	});
}
function Oc(e, n) {
	return new e({
		type: "void",
		...p(n)
	});
}
function Nc(e, n) {
	return new e({
		type: "date",
		...p(n)
	});
}
function Pc(e, n) {
	return new e({
		type: "date",
		coerce: !0,
		...p(n)
	});
}
function Tc(e, n) {
	return new e({
		type: "nan",
		...p(n)
	});
}
function re(e, n) {
	return new Yn({
		check: "less_than",
		...p(n),
		value: e,
		inclusive: !1
	});
}
function K(e, n) {
	return new Yn({
		check: "less_than",
		...p(n),
		value: e,
		inclusive: !0
	});
}
function ie(e, n) {
	return new Hn({
		check: "greater_than",
		...p(n),
		value: e,
		inclusive: !1
	});
}
function C(e, n) {
	return new Hn({
		check: "greater_than",
		...p(n),
		value: e,
		inclusive: !0
	});
}
function Zr(e) {
	return ie(0, e);
}
function Ur(e) {
	return re(0, e);
}
function jr(e) {
	return K(0, e);
}
function Dr(e) {
	return C(0, e);
}
function Ie(e, n) {
	return new _a({
		check: "multiple_of",
		...p(n),
		value: e
	});
}
function De(e, n) {
	return new ka({
		check: "max_size",
		...p(n),
		maximum: e
	});
}
function oe(e, n) {
	return new Sa({
		check: "min_size",
		...p(n),
		minimum: e
	});
}
function He(e, n) {
	return new Ia({
		check: "size_equals",
		...p(n),
		size: e
	});
}
function Qe(e, n) {
	return new za({
		check: "max_length",
		...p(n),
		maximum: e
	});
}
function fe(e, n) {
	return new wa({
		check: "min_length",
		...p(n),
		minimum: e
	});
}
function et(e, n) {
	return new xa({
		check: "length_equals",
		...p(n),
		length: e
	});
}
function Tt(e, n) {
	return new Za({
		check: "string_format",
		format: "regex",
		...p(n),
		pattern: e
	});
}
function Et(e) {
	return new Ua({
		check: "string_format",
		format: "lowercase",
		...p(e)
	});
}
function At(e) {
	return new ja({
		check: "string_format",
		format: "uppercase",
		...p(e)
	});
}
function Ct(e, n) {
	return new Da({
		check: "string_format",
		format: "includes",
		...p(n),
		includes: e
	});
}
function Rt(e, n) {
	return new Oa({
		check: "string_format",
		format: "starts_with",
		...p(n),
		prefix: e
	});
}
function Lt(e, n) {
	return new Na({
		check: "string_format",
		format: "ends_with",
		...p(n),
		suffix: e
	});
}
function Or(e, n, i) {
	return new Pa({
		check: "property",
		property: e,
		schema: n,
		...p(i)
	});
}
function Ft(e, n) {
	return new Ta({
		check: "mime_type",
		mime: e,
		...p(n)
	});
}
function ee(e) {
	return new Ea({
		check: "overwrite",
		tx: e
	});
}
function Jt(e) {
	return ee((n) => n.normalize(e));
}
function Mt() {
	return ee((e) => e.trim());
}
function Kt() {
	return ee((e) => e.toLowerCase());
}
function Gt() {
	return ee((e) => e.toUpperCase());
}
function Vt() {
	return ee((e) => go(e));
}
function Ec(e, n, i) {
	return new e({
		type: "array",
		element: n,
		...p(i)
	});
}
function ap(e, n, i) {
	return new e({
		type: "union",
		options: n,
		...p(i)
	});
}
function up(e, n, i) {
	return new e({
		type: "union",
		options: n,
		inclusive: !1,
		...p(i)
	});
}
function cp(e, n, i, o) {
	return new e({
		type: "union",
		options: i,
		discriminator: n,
		...p(o)
	});
}
function lp(e, n, i) {
	return new e({
		type: "intersection",
		left: n,
		right: i
	});
}
function sp(e, n, i, o) {
	const t = i instanceof y;
	return new e({
		type: "tuple",
		items: n,
		rest: t ? i : null,
		...p(t ? o : i)
	});
}
function dp(e, n, i, o) {
	return new e({
		type: "record",
		keyType: n,
		valueType: i,
		...p(o)
	});
}
function mp(e, n, i, o) {
	return new e({
		type: "map",
		keyType: n,
		valueType: i,
		...p(o)
	});
}
function fp(e, n, i) {
	return new e({
		type: "set",
		valueType: n,
		...p(i)
	});
}
function pp(e, n, i) {
	return new e({
		type: "enum",
		entries: Array.isArray(n) ? Object.fromEntries(n.map((o) => [o, o])) : n,
		...p(i)
	});
}
function vp(e, n, i) {
	return new e({
		type: "enum",
		entries: n,
		...p(i)
	});
}
function gp(e, n, i) {
	return new e({
		type: "literal",
		values: Array.isArray(n) ? n : [n],
		...p(i)
	});
}
function Ac(e, n) {
	return new e({
		type: "file",
		...p(n)
	});
}
function hp(e, n) {
	return new e({
		type: "transform",
		transform: n
	});
}
function $p(e, n) {
	return new e({
		type: "optional",
		innerType: n
	});
}
function _p(e, n) {
	return new e({
		type: "nullable",
		innerType: n
	});
}
function bp(e, n, i) {
	return new e({
		type: "default",
		innerType: n,
		get defaultValue() {
			return typeof i == "function" ? i() : jt(i);
		}
	});
}
function yp(e, n, i) {
	return new e({
		type: "nonoptional",
		innerType: n,
		...p(i)
	});
}
function kp(e, n) {
	return new e({
		type: "success",
		innerType: n
	});
}
function Sp(e, n, i) {
	return new e({
		type: "catch",
		innerType: n,
		catchValue: typeof i == "function" ? i : () => i
	});
}
function Ip(e, n, i) {
	return new e({
		type: "pipe",
		in: n,
		out: i
	});
}
function zp(e, n) {
	return new e({
		type: "readonly",
		innerType: n
	});
}
function wp(e, n, i) {
	return new e({
		type: "template_literal",
		parts: n,
		...p(i)
	});
}
function xp(e, n) {
	return new e({
		type: "lazy",
		getter: n
	});
}
function Zp(e, n) {
	return new e({
		type: "promise",
		innerType: n
	});
}
function Cc(e, n, i) {
	const o = p(i);
	return o.abort ?? (o.abort = !0), new e({
		type: "custom",
		check: "custom",
		fn: n,
		...o
	});
}
function Rc(e, n, i) {
	return new e({
		type: "custom",
		check: "custom",
		fn: n,
		...p(i)
	});
}
function Lc(e, n) {
	const i = Fc((o) => (o.addIssue = (t) => {
		if (typeof t == "string") o.issues.push(ke(t, o.value, i._zod.def));
		else {
			const r = t;
			r.fatal && (r.continue = !1), r.code ?? (r.code = "custom"), r.input ?? (r.input = o.value), r.inst ?? (r.inst = i), r.continue ?? (r.continue = !i._zod.def.abort), o.issues.push(ke(r));
		}
	}, e(o.value, o)), n);
	return i;
}
function Fc(e, n) {
	const i = new D({
		check: "custom",
		...p(n)
	});
	return i._zod.check = e, i;
}
function Jc(e) {
	const n = new D({ check: "describe" });
	return n._zod.onattach = [(i) => {
		const o = M.get(i) ?? {};
		M.add(i, {
			...o,
			description: e
		});
	}], n._zod.check = () => {}, n;
}
function Mc(e) {
	const n = new D({ check: "meta" });
	return n._zod.onattach = [(i) => {
		const o = M.get(i) ?? {};
		M.add(i, {
			...o,
			...e
		});
	}], n._zod.check = () => {}, n;
}
function Kc(e, n) {
	const i = p(n);
	let o = i.truthy ?? [
		"true",
		"1",
		"yes",
		"on",
		"y",
		"enabled"
	], t = i.falsy ?? [
		"false",
		"0",
		"no",
		"off",
		"n",
		"disabled"
	];
	i.case !== "sensitive" && (o = o.map((s) => typeof s == "string" ? s.toLowerCase() : s), t = t.map((s) => typeof s == "string" ? s.toLowerCase() : s));
	const r = new Set(o), a = new Set(t), u = e.Codec ?? ar, l = e.Boolean ?? tr, c = new u({
		type: "pipe",
		in: new (e.String ?? Ye)({
			type: "string",
			error: i.error
		}),
		out: new l({
			type: "boolean",
			error: i.error
		}),
		transform: ((s, f) => {
			let m = s;
			return i.case !== "sensitive" && (m = m.toLowerCase()), r.has(m) ? !0 : a.has(m) ? !1 : (f.issues.push({
				code: "invalid_value",
				expected: "stringbool",
				values: [...r, ...a],
				input: f.value,
				inst: c,
				continue: !1
			}), {});
		}),
		reverseTransform: ((s, f) => s === !0 ? o[0] || "true" : t[0] || "false"),
		error: i.error
	});
	return c;
}
function tt(e, n, i, o = {}) {
	const t = p(o), r = {
		...p(o),
		check: "string_format",
		type: "string",
		format: n,
		fn: typeof i == "function" ? i : (a) => i.test(a),
		...t
	};
	return i instanceof RegExp && (r.pattern = i), new e(r);
}
function ze(e) {
	let n = e?.target ?? "draft-2020-12";
	return n === "draft-4" && (n = "draft-04"), n === "draft-7" && (n = "draft-07"), {
		processors: e.processors ?? {},
		metadataRegistry: e?.metadata ?? M,
		target: n,
		unrepresentable: e?.unrepresentable ?? "throw",
		override: e?.override ?? (() => {}),
		io: e?.io ?? "output",
		counter: 0,
		seen: /* @__PURE__ */ new Map(),
		cycles: e?.cycles ?? "ref",
		reused: e?.reused ?? "inline",
		external: e?.external ?? void 0
	};
}
function w(e, n, i = {
	path: [],
	schemaPath: []
}) {
	var o;
	const t = e._zod.def, r = n.seen.get(e);
	if (r) return r.count++, i.schemaPath.includes(e) && (r.cycle = i.path), r.schema;
	const a = {
		schema: {},
		count: 1,
		cycle: void 0,
		path: i.path
	};
	n.seen.set(e, a);
	const u = e._zod.toJSONSchema?.();
	if (u) a.schema = u;
	else {
		const c = {
			...i,
			schemaPath: [...i.schemaPath, e],
			path: i.path
		};
		if (e._zod.processJSONSchema) e._zod.processJSONSchema(n, a.schema, c);
		else {
			const f = a.schema, m = n.processors[t.type];
			if (!m) throw new Error(`[toJSONSchema]: Non-representable type encountered: ${t.type}`);
			m(e, n, f, c);
		}
		const s = e._zod.parent;
		s && (a.ref || (a.ref = s), w(s, n, c), n.seen.get(s).isParent = !0);
	}
	const l = n.metadataRegistry.get(e);
	return l && Object.assign(a.schema, l), n.io === "input" && E(e) && (delete a.schema.examples, delete a.schema.default), n.io === "input" && "_prefault" in a.schema && ((o = a.schema).default ?? (o.default = a.schema._prefault)), delete a.schema._prefault, n.seen.get(e).schema;
}
function we(e, n) {
	const i = e.seen.get(n);
	if (!i) throw new Error("Unprocessed schema. This is a bug in Zod.");
	const o = /* @__PURE__ */ new Map();
	for (const a of e.seen.entries()) {
		const u = e.metadataRegistry.get(a[0])?.id;
		if (u) {
			const l = o.get(u);
			if (l && l !== a[0]) throw new Error(`Duplicate schema id "${u}" detected during JSON Schema conversion. Two different schemas cannot share the same id when converted together.`);
			o.set(u, a[0]);
		}
	}
	const t = (a) => {
		const u = e.target === "draft-2020-12" ? "$defs" : "definitions";
		if (e.external) {
			const s = e.external.registry.get(a[0])?.id, f = e.external.uri ?? ((g) => g);
			if (s) return { ref: f(s) };
			const m = a[1].defId ?? a[1].schema.id ?? `schema${e.counter++}`;
			return a[1].defId = m, {
				defId: m,
				ref: `${f("__shared")}#/${u}/${m}`
			};
		}
		if (a[1] === i) return { ref: "#" };
		const l = `#/${u}/`, c = a[1].schema.id ?? `__schema${e.counter++}`;
		return {
			defId: c,
			ref: l + c
		};
	}, r = (a) => {
		if (a[1].schema.$ref) return;
		const u = a[1], { ref: l, defId: c } = t(a);
		u.def = { ...u.schema }, c && (u.defId = c);
		const s = u.schema;
		for (const f in s) delete s[f];
		s.$ref = l;
	};
	if (e.cycles === "throw") for (const a of e.seen.entries()) {
		const u = a[1];
		if (u.cycle) throw new Error(`Cycle detected: #/${u.cycle?.join("/")}/<root>

Set the \`cycles\` parameter to \`"ref"\` to resolve cyclical schemas with defs.`);
	}
	for (const a of e.seen.entries()) {
		const u = a[1];
		if (n === a[0]) {
			r(a);
			continue;
		}
		if (e.external) {
			const l = e.external.registry.get(a[0])?.id;
			if (n !== a[0] && l) {
				r(a);
				continue;
			}
		}
		if (e.metadataRegistry.get(a[0])?.id) {
			r(a);
			continue;
		}
		if (u.cycle) {
			r(a);
			continue;
		}
		if (u.count > 1 && e.reused === "ref") {
			r(a);
			continue;
		}
	}
}
function xe(e, n) {
	const i = e.seen.get(n);
	if (!i) throw new Error("Unprocessed schema. This is a bug in Zod.");
	const o = (u) => {
		const l = e.seen.get(u);
		if (l.ref === null) return;
		const c = l.def ?? l.schema, s = { ...c }, f = l.ref;
		if (l.ref = null, f) {
			o(f);
			const g = e.seen.get(f), I = g.schema;
			if (I.$ref && (e.target === "draft-07" || e.target === "draft-04" || e.target === "openapi-3.0") ? (c.allOf = c.allOf ?? [], c.allOf.push(I)) : Object.assign(c, I), Object.assign(c, s), u._zod.parent === f) for (const U in c) U === "$ref" || U === "allOf" || U in s || delete c[U];
			if (I.$ref && g.def) for (const U in c) U === "$ref" || U === "allOf" || U in g.def && JSON.stringify(c[U]) === JSON.stringify(g.def[U]) && delete c[U];
		}
		const m = u._zod.parent;
		if (m && m !== f) {
			o(m);
			const g = e.seen.get(m);
			if (g?.schema.$ref && (c.$ref = g.schema.$ref, g.def)) for (const I in c) I === "$ref" || I === "allOf" || I in g.def && JSON.stringify(c[I]) === JSON.stringify(g.def[I]) && delete c[I];
		}
		e.override({
			zodSchema: u,
			jsonSchema: c,
			path: l.path ?? []
		});
	};
	for (const u of [...e.seen.entries()].reverse()) o(u[0]);
	const t = {};
	if (e.target === "draft-2020-12" ? t.$schema = "https://json-schema.org/draft/2020-12/schema" : e.target === "draft-07" ? t.$schema = "http://json-schema.org/draft-07/schema#" : e.target === "draft-04" ? t.$schema = "http://json-schema.org/draft-04/schema#" : e.target, e.external?.uri) {
		const u = e.external.registry.get(n)?.id;
		if (!u) throw new Error("Schema is missing an `id` property");
		t.$id = e.external.uri(u);
	}
	Object.assign(t, i.def ?? i.schema);
	const r = e.metadataRegistry.get(n)?.id;
	r !== void 0 && t.id === r && delete t.id;
	const a = e.external?.defs ?? {};
	for (const u of e.seen.entries()) {
		const l = u[1];
		l.def && l.defId && (l.def.id === l.defId && delete l.def.id, a[l.defId] = l.def);
	}
	e.external || Object.keys(a).length > 0 && (e.target === "draft-2020-12" ? t.$defs = a : t.definitions = a);
	try {
		const u = JSON.parse(JSON.stringify(t));
		return Object.defineProperty(u, "~standard", {
			value: {
				...n["~standard"],
				jsonSchema: {
					input: Ae(n, "input", e.processors),
					output: Ae(n, "output", e.processors)
				}
			},
			enumerable: !1,
			writable: !1
		}), u;
	} catch {
		throw new Error("Error converting schema to JSON.");
	}
}
function E(e, n) {
	const i = n ?? { seen: /* @__PURE__ */ new Set() };
	if (i.seen.has(e)) return !1;
	i.seen.add(e);
	const o = e._zod.def;
	if (o.type === "transform") return !0;
	if (o.type === "array") return E(o.element, i);
	if (o.type === "set") return E(o.valueType, i);
	if (o.type === "lazy") return E(o.getter(), i);
	if (o.type === "promise" || o.type === "optional" || o.type === "nonoptional" || o.type === "nullable" || o.type === "readonly" || o.type === "default" || o.type === "prefault") return E(o.innerType, i);
	if (o.type === "intersection") return E(o.left, i) || E(o.right, i);
	if (o.type === "record" || o.type === "map") return E(o.keyType, i) || E(o.valueType, i);
	if (o.type === "pipe") return e._zod.traits.has("$ZodCodec") ? !0 : E(o.in, i) || E(o.out, i);
	if (o.type === "object") {
		for (const t in o.shape) if (E(o.shape[t], i)) return !0;
		return !1;
	}
	if (o.type === "union") {
		for (const t of o.options) if (E(t, i)) return !0;
		return !1;
	}
	if (o.type === "tuple") {
		for (const t of o.items) if (E(t, i)) return !0;
		return !!(o.rest && E(o.rest, i));
	}
	return !1;
}
const Gc = (e, n = {}) => (i) => {
	const o = ze({
		...i,
		processors: n
	});
	return w(e, o), we(o, e), xe(o, e);
}, Ae = (e, n, i = {}) => (o) => {
	const { libraryOptions: t, target: r } = o ?? {}, a = ze({
		...t ?? {},
		target: r,
		io: n,
		processors: i
	});
	return w(e, a), we(a, e), xe(a, e);
}, Up = {
	guid: "uuid",
	url: "uri",
	datetime: "date-time",
	json_string: "json-string",
	regex: ""
}, Vc = (e, n, i, o) => {
	const t = i;
	t.type = "string";
	const { minimum: r, maximum: a, format: u, patterns: l, contentEncoding: c } = e._zod.bag;
	if (typeof r == "number" && (t.minLength = r), typeof a == "number" && (t.maxLength = a), u && (t.format = Up[u] ?? u, t.format === "" && delete t.format, u === "time" && delete t.format), c && (t.contentEncoding = c), l && l.size > 0) {
		const s = [...l];
		s.length === 1 ? t.pattern = s[0].source : s.length > 1 && (t.allOf = [...s.map((f) => ({
			...n.target === "draft-07" || n.target === "draft-04" || n.target === "openapi-3.0" ? { type: "string" } : {},
			pattern: f.source
		}))]);
	}
}, Bc = (e, n, i, o) => {
	const t = i, { minimum: r, maximum: a, format: u, multipleOf: l, exclusiveMaximum: c, exclusiveMinimum: s } = e._zod.bag;
	typeof u == "string" && u.includes("int") ? t.type = "integer" : t.type = "number";
	const f = typeof s == "number" && s >= (r ?? Number.NEGATIVE_INFINITY), m = typeof c == "number" && c <= (a ?? Number.POSITIVE_INFINITY), g = n.target === "draft-04" || n.target === "openapi-3.0";
	f ? g ? (t.minimum = s, t.exclusiveMinimum = !0) : t.exclusiveMinimum = s : typeof r == "number" && (t.minimum = r), m ? g ? (t.maximum = c, t.exclusiveMaximum = !0) : t.exclusiveMaximum = c : typeof a == "number" && (t.maximum = a), typeof l == "number" && (t.multipleOf = l);
}, Wc = (e, n, i, o) => {
	i.type = "boolean";
}, Xc = (e, n, i, o) => {
	if (n.unrepresentable === "throw") throw new Error("BigInt cannot be represented in JSON Schema");
}, qc = (e, n, i, o) => {
	if (n.unrepresentable === "throw") throw new Error("Symbols cannot be represented in JSON Schema");
}, Yc = (e, n, i, o) => {
	n.target === "openapi-3.0" ? (i.type = "string", i.nullable = !0, i.enum = [null]) : i.type = "null";
}, Hc = (e, n, i, o) => {
	if (n.unrepresentable === "throw") throw new Error("Undefined cannot be represented in JSON Schema");
}, Qc = (e, n, i, o) => {
	if (n.unrepresentable === "throw") throw new Error("Void cannot be represented in JSON Schema");
}, el = (e, n, i, o) => {
	i.not = {};
}, tl = (e, n, i, o) => {}, nl = (e, n, i, o) => {}, rl = (e, n, i, o) => {
	if (n.unrepresentable === "throw") throw new Error("Date cannot be represented in JSON Schema");
}, il = (e, n, i, o) => {
	const t = e._zod.def, r = Pn(t.entries);
	r.every((a) => typeof a == "number") && (i.type = "number"), r.every((a) => typeof a == "string") && (i.type = "string"), i.enum = r;
}, ol = (e, n, i, o) => {
	const t = e._zod.def, r = [];
	for (const a of t.values) if (a === void 0) {
		if (n.unrepresentable === "throw") throw new Error("Literal `undefined` cannot be represented in JSON Schema");
	} else if (typeof a == "bigint") {
		if (n.unrepresentable === "throw") throw new Error("BigInt literals cannot be represented in JSON Schema");
		r.push(Number(a));
	} else r.push(a);
	if (r.length !== 0) if (r.length === 1) {
		const a = r[0];
		i.type = a === null ? "null" : typeof a, n.target === "draft-04" || n.target === "openapi-3.0" ? i.enum = [a] : i.const = a;
	} else r.every((a) => typeof a == "number") && (i.type = "number"), r.every((a) => typeof a == "string") && (i.type = "string"), r.every((a) => typeof a == "boolean") && (i.type = "boolean"), r.every((a) => a === null) && (i.type = "null"), i.enum = r;
}, al = (e, n, i, o) => {
	if (n.unrepresentable === "throw") throw new Error("NaN cannot be represented in JSON Schema");
}, ul = (e, n, i, o) => {
	const t = i, r = e._zod.pattern;
	if (!r) throw new Error("Pattern not found in template literal");
	t.type = "string", t.pattern = r.source;
}, cl = (e, n, i, o) => {
	const t = i, r = {
		type: "string",
		format: "binary",
		contentEncoding: "binary"
	}, { minimum: a, maximum: u, mime: l } = e._zod.bag;
	a !== void 0 && (r.minLength = a), u !== void 0 && (r.maxLength = u), l ? l.length === 1 ? (r.contentMediaType = l[0], Object.assign(t, r)) : (Object.assign(t, r), t.anyOf = l.map((c) => ({ contentMediaType: c }))) : Object.assign(t, r);
}, ll = (e, n, i, o) => {
	i.type = "boolean";
}, sl = (e, n, i, o) => {
	if (n.unrepresentable === "throw") throw new Error("Custom types cannot be represented in JSON Schema");
}, dl = (e, n, i, o) => {
	if (n.unrepresentable === "throw") throw new Error("Function types cannot be represented in JSON Schema");
}, ml = (e, n, i, o) => {
	if (n.unrepresentable === "throw") throw new Error("Transforms cannot be represented in JSON Schema");
}, fl = (e, n, i, o) => {
	if (n.unrepresentable === "throw") throw new Error("Map cannot be represented in JSON Schema");
}, pl = (e, n, i, o) => {
	if (n.unrepresentable === "throw") throw new Error("Set cannot be represented in JSON Schema");
}, vl = (e, n, i, o) => {
	const t = i, r = e._zod.def, { minimum: a, maximum: u } = e._zod.bag;
	typeof a == "number" && (t.minItems = a), typeof u == "number" && (t.maxItems = u), t.type = "array", t.items = w(r.element, n, {
		...o,
		path: [...o.path, "items"]
	});
}, gl = (e, n, i, o) => {
	const t = i, r = e._zod.def;
	t.type = "object", t.properties = {};
	const a = r.shape;
	for (const c in a) t.properties[c] = w(a[c], n, {
		...o,
		path: [
			...o.path,
			"properties",
			c
		]
	});
	const u = new Set(Object.keys(a)), l = new Set([...u].filter((c) => {
		const s = r.shape[c]._zod;
		return n.io === "input" ? s.optin === void 0 : s.optout === void 0;
	}));
	l.size > 0 && (t.required = Array.from(l)), r.catchall?._zod.def.type === "never" ? t.additionalProperties = !1 : r.catchall ? r.catchall && (t.additionalProperties = w(r.catchall, n, {
		...o,
		path: [...o.path, "additionalProperties"]
	})) : n.io === "output" && (t.additionalProperties = !1);
}, Nr = (e, n, i, o) => {
	const t = e._zod.def, r = t.inclusive === !1, a = t.options.map((u, l) => w(u, n, {
		...o,
		path: [
			...o.path,
			r ? "oneOf" : "anyOf",
			l
		]
	}));
	r ? i.oneOf = a : i.anyOf = a;
}, hl = (e, n, i, o) => {
	const t = e._zod.def, r = w(t.left, n, {
		...o,
		path: [
			...o.path,
			"allOf",
			0
		]
	}), a = w(t.right, n, {
		...o,
		path: [
			...o.path,
			"allOf",
			1
		]
	}), u = (l) => "allOf" in l && Object.keys(l).length === 1;
	i.allOf = [...u(r) ? r.allOf : [r], ...u(a) ? a.allOf : [a]];
}, $l = (e, n, i, o) => {
	const t = i, r = e._zod.def;
	t.type = "array";
	const a = n.target === "draft-2020-12" ? "prefixItems" : "items", u = n.target === "draft-2020-12" || n.target === "openapi-3.0" ? "items" : "additionalItems", l = r.items.map((m, g) => w(m, n, {
		...o,
		path: [
			...o.path,
			a,
			g
		]
	})), c = r.rest ? w(r.rest, n, {
		...o,
		path: [
			...o.path,
			u,
			...n.target === "openapi-3.0" ? [r.items.length] : []
		]
	}) : null;
	n.target === "draft-2020-12" ? (t.prefixItems = l, c && (t.items = c)) : n.target === "openapi-3.0" ? (t.items = { anyOf: l }, c && t.items.anyOf.push(c), t.minItems = l.length, c || (t.maxItems = l.length)) : (t.items = l, c && (t.additionalItems = c));
	const { minimum: s, maximum: f } = e._zod.bag;
	typeof s == "number" && (t.minItems = s), typeof f == "number" && (t.maxItems = f);
}, _l = (e, n, i, o) => {
	const t = i, r = e._zod.def;
	t.type = "object";
	const a = r.keyType, u = a._zod.bag?.patterns;
	if (r.mode === "loose" && u && u.size > 0) {
		const c = w(r.valueType, n, {
			...o,
			path: [
				...o.path,
				"patternProperties",
				"*"
			]
		});
		t.patternProperties = {};
		for (const s of u) t.patternProperties[s.source] = c;
	} else (n.target === "draft-07" || n.target === "draft-2020-12") && (t.propertyNames = w(r.keyType, n, {
		...o,
		path: [...o.path, "propertyNames"]
	})), t.additionalProperties = w(r.valueType, n, {
		...o,
		path: [...o.path, "additionalProperties"]
	});
	const l = a._zod.values;
	if (l) {
		const c = [...l].filter((s) => typeof s == "string" || typeof s == "number");
		c.length > 0 && (t.required = c);
	}
}, bl = (e, n, i, o) => {
	const t = e._zod.def, r = w(t.innerType, n, o), a = n.seen.get(e);
	n.target === "openapi-3.0" ? (a.ref = t.innerType, i.nullable = !0) : i.anyOf = [r, { type: "null" }];
}, yl = (e, n, i, o) => {
	const t = e._zod.def;
	w(t.innerType, n, o);
	const r = n.seen.get(e);
	r.ref = t.innerType;
}, kl = (e, n, i, o) => {
	const t = e._zod.def;
	w(t.innerType, n, o);
	const r = n.seen.get(e);
	r.ref = t.innerType, i.default = JSON.parse(JSON.stringify(t.defaultValue));
}, Sl = (e, n, i, o) => {
	const t = e._zod.def;
	w(t.innerType, n, o);
	const r = n.seen.get(e);
	r.ref = t.innerType, n.io === "input" && (i._prefault = JSON.parse(JSON.stringify(t.defaultValue)));
}, Il = (e, n, i, o) => {
	const t = e._zod.def;
	w(t.innerType, n, o);
	const r = n.seen.get(e);
	r.ref = t.innerType;
	let a;
	try {
		a = t.catchValue(void 0);
	} catch {
		throw new Error("Dynamic catch values are not supported in JSON Schema");
	}
	i.default = a;
}, zl = (e, n, i, o) => {
	const t = e._zod.def, r = t.in._zod.traits.has("$ZodTransform"), a = n.io === "input" ? r ? t.out : t.in : t.out;
	w(a, n, o);
	const u = n.seen.get(e);
	u.ref = a;
}, wl = (e, n, i, o) => {
	const t = e._zod.def;
	w(t.innerType, n, o);
	const r = n.seen.get(e);
	r.ref = t.innerType, i.readOnly = !0;
}, xl = (e, n, i, o) => {
	const t = e._zod.def;
	w(t.innerType, n, o);
	const r = n.seen.get(e);
	r.ref = t.innerType;
}, Pr = (e, n, i, o) => {
	const t = e._zod.def;
	w(t.innerType, n, o);
	const r = n.seen.get(e);
	r.ref = t.innerType;
}, Zl = (e, n, i, o) => {
	const t = e._zod.innerType;
	w(t, n, o);
	const r = n.seen.get(e);
	r.ref = t;
}, Zn = {
	string: Vc,
	number: Bc,
	boolean: Wc,
	bigint: Xc,
	symbol: qc,
	null: Yc,
	undefined: Hc,
	void: Qc,
	never: el,
	any: tl,
	unknown: nl,
	date: rl,
	enum: il,
	literal: ol,
	nan: al,
	template_literal: ul,
	file: cl,
	success: ll,
	custom: sl,
	function: dl,
	transform: ml,
	map: fl,
	set: pl,
	array: vl,
	object: gl,
	union: Nr,
	intersection: hl,
	tuple: $l,
	record: _l,
	nullable: bl,
	nonoptional: yl,
	default: kl,
	prefault: Sl,
	catch: Il,
	pipe: zl,
	readonly: wl,
	promise: xl,
	optional: Pr,
	lazy: Zl
};
function Ul(e, n) {
	if ("_idmap" in e) {
		const o = e, t = ze({
			...n,
			processors: Zn
		}), r = {};
		for (const u of o._idmap.entries()) {
			const [l, c] = u;
			w(c, t);
		}
		const a = {};
		t.external = {
			registry: o,
			uri: n?.uri,
			defs: r
		};
		for (const u of o._idmap.entries()) {
			const [l, c] = u;
			we(t, c), a[l] = xe(t, c);
		}
		return Object.keys(r).length > 0 && (a.__shared = { [t.target === "draft-2020-12" ? "$defs" : "definitions"]: r }), { schemas: a };
	}
	const i = ze({
		...n,
		processors: Zn
	});
	return w(e, i), we(i, e), xe(i, e);
}
var jp = class {
	get metadataRegistry() {
		return this.ctx.metadataRegistry;
	}
	get target() {
		return this.ctx.target;
	}
	get unrepresentable() {
		return this.ctx.unrepresentable;
	}
	get override() {
		return this.ctx.override;
	}
	get io() {
		return this.ctx.io;
	}
	get counter() {
		return this.ctx.counter;
	}
	set counter(e) {
		this.ctx.counter = e;
	}
	get seen() {
		return this.ctx.seen;
	}
	constructor(e) {
		let n = e?.target ?? "draft-2020-12";
		n === "draft-4" && (n = "draft-04"), n === "draft-7" && (n = "draft-07"), this.ctx = ze({
			processors: Zn,
			target: n,
			...e?.metadata && { metadata: e.metadata },
			...e?.unrepresentable && { unrepresentable: e.unrepresentable },
			...e?.override && { override: e.override },
			...e?.io && { io: e.io }
		});
	}
	process(e, n = {
		path: [],
		schemaPath: []
	}) {
		return w(e, this.ctx, n);
	}
	emit(e, n) {
		n && (n.cycles && (this.ctx.cycles = n.cycles), n.reused && (this.ctx.reused = n.reused), n.external && (this.ctx.external = n.external)), we(this.ctx, e);
		const { "~standard": i, ...o } = xe(this.ctx, e);
		return o;
	}
}, Dp = W({}), Op = W({
	$ZodAny: () => hu,
	$ZodArray: () => ku,
	$ZodAsyncError: () => de,
	$ZodBase64: () => ou,
	$ZodBase64URL: () => uu,
	$ZodBigInt: () => nr,
	$ZodBigIntFormat: () => fu,
	$ZodBoolean: () => tr,
	$ZodCIDRv4: () => ru,
	$ZodCIDRv6: () => iu,
	$ZodCUID: () => Ga,
	$ZodCUID2: () => Va,
	$ZodCatch: () => Mu,
	$ZodCheck: () => D,
	$ZodCheckBigIntFormat: () => ya,
	$ZodCheckEndsWith: () => Na,
	$ZodCheckGreaterThan: () => Hn,
	$ZodCheckIncludes: () => Da,
	$ZodCheckLengthEquals: () => xa,
	$ZodCheckLessThan: () => Yn,
	$ZodCheckLowerCase: () => Ua,
	$ZodCheckMaxLength: () => za,
	$ZodCheckMaxSize: () => ka,
	$ZodCheckMimeType: () => Ta,
	$ZodCheckMinLength: () => wa,
	$ZodCheckMinSize: () => Sa,
	$ZodCheckMultipleOf: () => _a,
	$ZodCheckNumberFormat: () => ba,
	$ZodCheckOverwrite: () => Ea,
	$ZodCheckProperty: () => Pa,
	$ZodCheckRegex: () => Za,
	$ZodCheckSizeEquals: () => Ia,
	$ZodCheckStartsWith: () => Oa,
	$ZodCheckStringFormat: () => qe,
	$ZodCheckUpperCase: () => ja,
	$ZodCodec: () => ar,
	$ZodCustom: () => Yu,
	$ZodCustomStringFormat: () => du,
	$ZodDate: () => yu,
	$ZodDefault: () => Ru,
	$ZodDiscriminatedUnion: () => Zu,
	$ZodE164: () => cu,
	$ZodEmail: () => Fa,
	$ZodEmoji: () => Ma,
	$ZodEncodeError: () => Zt,
	$ZodEnum: () => Nu,
	$ZodError: () => En,
	$ZodExactOptional: () => Au,
	$ZodFile: () => Tu,
	$ZodFunction: () => Wu,
	$ZodGUID: () => Ra,
	$ZodIPv4: () => eu,
	$ZodIPv6: () => tu,
	$ZodISODate: () => Ya,
	$ZodISODateTime: () => qa,
	$ZodISODuration: () => Qa,
	$ZodISOTime: () => Ha,
	$ZodIntersection: () => Uu,
	$ZodJWT: () => su,
	$ZodKSUID: () => Xa,
	$ZodLazy: () => qu,
	$ZodLiteral: () => Pu,
	$ZodMAC: () => nu,
	$ZodMap: () => Du,
	$ZodNaN: () => Ku,
	$ZodNanoID: () => Ka,
	$ZodNever: () => _u,
	$ZodNonOptional: () => Fu,
	$ZodNull: () => gu,
	$ZodNullable: () => Cu,
	$ZodNumber: () => er,
	$ZodNumberFormat: () => mu,
	$ZodObject: () => zu,
	$ZodObjectJIT: () => wu,
	$ZodOptional: () => ir,
	$ZodPipe: () => or,
	$ZodPrefault: () => Lu,
	$ZodPreprocess: () => Gu,
	$ZodPromise: () => Xu,
	$ZodReadonly: () => Vu,
	$ZodRealError: () => L,
	$ZodRecord: () => ju,
	$ZodRegistry: () => ic,
	$ZodSet: () => Ou,
	$ZodString: () => Ye,
	$ZodStringFormat: () => x,
	$ZodSuccess: () => Ju,
	$ZodSymbol: () => pu,
	$ZodTemplateLiteral: () => Bu,
	$ZodTransform: () => Eu,
	$ZodTuple: () => rr,
	$ZodType: () => y,
	$ZodULID: () => Ba,
	$ZodURL: () => Ja,
	$ZodUUID: () => La,
	$ZodUndefined: () => vu,
	$ZodUnion: () => Nt,
	$ZodUnknown: () => $u,
	$ZodVoid: () => bu,
	$ZodXID: () => Wa,
	$ZodXor: () => xu,
	$brand: () => fo,
	$constructor: () => d,
	$input: () => rc,
	$output: () => nc,
	Doc: () => Aa,
	JSONSchema: () => Dp,
	JSONSchemaGenerator: () => jp,
	NEVER: () => mo,
	TimePrecision: () => cc,
	_any: () => Uc,
	_array: () => Ec,
	_base64: () => Ir,
	_base64url: () => zr,
	_bigint: () => kc,
	_boolean: () => bc,
	_catch: () => Sp,
	_check: () => Fc,
	_cidrv4: () => kr,
	_cidrv6: () => Sr,
	_coercedBigint: () => Sc,
	_coercedBoolean: () => yc,
	_coercedDate: () => Pc,
	_coercedNumber: () => pc,
	_coercedString: () => ac,
	_cuid: () => vr,
	_cuid2: () => gr,
	_custom: () => Cc,
	_date: () => Nc,
	_decode: () => Ln,
	_decodeAsync: () => Jn,
	_default: () => bp,
	_discriminatedUnion: () => cp,
	_e164: () => wr,
	_email: () => cr,
	_emoji: () => fr,
	_encode: () => Rn,
	_encodeAsync: () => Fn,
	_endsWith: () => Lt,
	_enum: () => pp,
	_file: () => Ac,
	_float32: () => gc,
	_float64: () => hc,
	_gt: () => ie,
	_gte: () => C,
	_guid: () => St,
	_includes: () => Ct,
	_int: () => vc,
	_int32: () => $c,
	_int64: () => Ic,
	_intersection: () => lp,
	_ipv4: () => br,
	_ipv6: () => yr,
	_isoDate: () => sc,
	_isoDateTime: () => lc,
	_isoDuration: () => mc,
	_isoTime: () => dc,
	_jwt: () => xr,
	_ksuid: () => _r,
	_lazy: () => xp,
	_length: () => et,
	_literal: () => gp,
	_lowercase: () => Et,
	_lt: () => re,
	_lte: () => K,
	_mac: () => uc,
	_map: () => mp,
	_max: () => K,
	_maxLength: () => Qe,
	_maxSize: () => De,
	_mime: () => Ft,
	_min: () => C,
	_minLength: () => fe,
	_minSize: () => oe,
	_multipleOf: () => Ie,
	_nan: () => Tc,
	_nanoid: () => pr,
	_nativeEnum: () => vp,
	_negative: () => Ur,
	_never: () => Dc,
	_nonnegative: () => Dr,
	_nonoptional: () => yp,
	_nonpositive: () => jr,
	_normalize: () => Jt,
	_null: () => Zc,
	_nullable: () => _p,
	_number: () => fc,
	_optional: () => $p,
	_overwrite: () => ee,
	_parse: () => Ke,
	_parseAsync: () => Ge,
	_pipe: () => Ip,
	_positive: () => Zr,
	_promise: () => Zp,
	_property: () => Or,
	_readonly: () => zp,
	_record: () => dp,
	_refine: () => Rc,
	_regex: () => Tt,
	_safeDecode: () => Kn,
	_safeDecodeAsync: () => Vn,
	_safeEncode: () => Mn,
	_safeEncodeAsync: () => Gn,
	_safeParse: () => Ve,
	_safeParseAsync: () => Be,
	_set: () => fp,
	_size: () => He,
	_slugify: () => Vt,
	_startsWith: () => Rt,
	_string: () => oc,
	_stringFormat: () => tt,
	_stringbool: () => Kc,
	_success: () => kp,
	_superRefine: () => Lc,
	_symbol: () => wc,
	_templateLiteral: () => wp,
	_toLowerCase: () => Kt,
	_toUpperCase: () => Gt,
	_transform: () => hp,
	_trim: () => Mt,
	_tuple: () => sp,
	_uint32: () => _c,
	_uint64: () => zc,
	_ulid: () => hr,
	_undefined: () => xc,
	_union: () => ap,
	_unknown: () => jc,
	_uppercase: () => At,
	_url: () => Pt,
	_uuid: () => lr,
	_uuidv4: () => sr,
	_uuidv6: () => dr,
	_uuidv7: () => mr,
	_void: () => Oc,
	_xid: () => $r,
	_xor: () => up,
	clone: () => G,
	config: () => P,
	createStandardJSONSchemaMethod: () => Ae,
	createToJSONSchemaMethod: () => Gc,
	decode: () => Ad,
	decodeAsync: () => Rd,
	describe: () => Jc,
	encode: () => Ed,
	encodeAsync: () => Cd,
	extractDefs: () => we,
	finalize: () => xe,
	flattenError: () => An,
	formatError: () => Cn,
	globalConfig: () => Ee,
	globalRegistry: () => M,
	initializeContext: () => ze,
	isValidBase64: () => Qn,
	isValidBase64URL: () => au,
	isValidJWT: () => lu,
	locales: () => tc,
	meta: () => Mc,
	parse: () => zn,
	parseAsync: () => wn,
	prettifyError: () => To,
	process: () => w,
	regexes: () => Bn,
	registry: () => ur,
	safeDecode: () => Fd,
	safeDecodeAsync: () => Md,
	safeEncode: () => Ld,
	safeEncodeAsync: () => Jd,
	safeParse: () => Eo,
	safeParseAsync: () => Ao,
	toDotPath: () => Po,
	toJSONSchema: () => Ul,
	treeifyError: () => No,
	util: () => po,
	version: () => Ca
}), Np = W({
	endsWith: () => Lt,
	gt: () => ie,
	gte: () => C,
	includes: () => Ct,
	length: () => et,
	lowercase: () => Et,
	lt: () => re,
	lte: () => K,
	maxLength: () => Qe,
	maxSize: () => De,
	mime: () => Ft,
	minLength: () => fe,
	minSize: () => oe,
	multipleOf: () => Ie,
	negative: () => Ur,
	nonnegative: () => Dr,
	nonpositive: () => jr,
	normalize: () => Jt,
	overwrite: () => ee,
	positive: () => Zr,
	property: () => Or,
	regex: () => Tt,
	size: () => He,
	slugify: () => Vt,
	startsWith: () => Rt,
	toLowerCase: () => Kt,
	toUpperCase: () => Gt,
	trim: () => Mt,
	uppercase: () => At
}), jl = W({
	ZodISODate: () => Er,
	ZodISODateTime: () => Tr,
	ZodISODuration: () => Cr,
	ZodISOTime: () => Ar,
	date: () => Ol,
	datetime: () => Dl,
	duration: () => Pl,
	time: () => Nl
});
const Tr = d("ZodISODateTime", (e, n) => {
	qa.init(e, n), Z.init(e, n);
});
function Dl(e) {
	return lc(Tr, e);
}
const Er = d("ZodISODate", (e, n) => {
	Ya.init(e, n), Z.init(e, n);
});
function Ol(e) {
	return sc(Er, e);
}
const Ar = d("ZodISOTime", (e, n) => {
	Ha.init(e, n), Z.init(e, n);
});
function Nl(e) {
	return dc(Ar, e);
}
const Cr = d("ZodISODuration", (e, n) => {
	Qa.init(e, n), Z.init(e, n);
});
function Pl(e) {
	return mc(Cr, e);
}
const Tl = (e, n) => {
	En.init(e, n), e.name = "ZodError", Object.defineProperties(e, {
		format: { value: (i) => Cn(e, i) },
		flatten: { value: (i) => An(e, i) },
		addIssue: { value: (i) => {
			e.issues.push(i), e.message = JSON.stringify(e.issues, bt, 2);
		} },
		addIssues: { value: (i) => {
			e.issues.push(...i), e.message = JSON.stringify(e.issues, bt, 2);
		} },
		isEmpty: { get() {
			return e.issues.length === 0;
		} }
	});
}, Pp = d("ZodError", Tl), F = d("ZodError", Tl, { Parent: Error }), El = Ke(F), Al = Ge(F), Cl = Ve(F), Rl = Be(F), Ll = Rn(F), Fl = Ln(F), Jl = Fn(F), Ml = Jn(F), Kl = Mn(F), Gl = Kn(F), Vl = Gn(F), Bl = Vn(F);
var Tp = W({
	ZodAny: () => Vr,
	ZodArray: () => qr,
	ZodBase64: () => un,
	ZodBase64URL: () => cn,
	ZodBigInt: () => ut,
	ZodBigIntFormat: () => dn,
	ZodBoolean: () => at,
	ZodCIDRv4: () => on,
	ZodCIDRv6: () => an,
	ZodCUID: () => Yt,
	ZodCUID2: () => Ht,
	ZodCatch: () => $i,
	ZodCodec: () => mt,
	ZodCustom: () => ft,
	ZodCustomStringFormat: () => Oe,
	ZodDate: () => fn,
	ZodDefault: () => mi,
	ZodDiscriminatedUnion: () => Hr,
	ZodE164: () => ln,
	ZodEmail: () => Wt,
	ZodEmoji: () => Xt,
	ZodEnum: () => Ue,
	ZodExactOptional: () => li,
	ZodFile: () => ui,
	ZodFunction: () => Zi,
	ZodGUID: () => Re,
	ZodIPv4: () => nn,
	ZodIPv6: () => rn,
	ZodIntersection: () => Qr,
	ZodJWT: () => sn,
	ZodKSUID: () => tn,
	ZodLazy: () => zi,
	ZodLiteral: () => ai,
	ZodMAC: () => Rr,
	ZodMap: () => ii,
	ZodNaN: () => bi,
	ZodNanoID: () => qt,
	ZodNever: () => Wr,
	ZodNonOptional: () => $n,
	ZodNull: () => Kr,
	ZodNullable: () => di,
	ZodNumber: () => ot,
	ZodNumberFormat: () => ge,
	ZodObject: () => lt,
	ZodOptional: () => hn,
	ZodPipe: () => dt,
	ZodPrefault: () => pi,
	ZodPreprocess: () => yi,
	ZodPromise: () => xi,
	ZodReadonly: () => ki,
	ZodRecord: () => Ze,
	ZodSet: () => oi,
	ZodString: () => rt,
	ZodStringFormat: () => Z,
	ZodSuccess: () => hi,
	ZodSymbol: () => Jr,
	ZodTemplateLiteral: () => Ii,
	ZodTransform: () => ci,
	ZodTuple: () => ti,
	ZodType: () => k,
	ZodULID: () => Qt,
	ZodURL: () => it,
	ZodUUID: () => B,
	ZodUndefined: () => Mr,
	ZodUnion: () => st,
	ZodUnknown: () => Br,
	ZodVoid: () => Xr,
	ZodXID: () => en,
	ZodXor: () => Yr,
	_ZodString: () => Bt,
	_default: () => fi,
	_function: () => wt,
	any: () => Ds,
	array: () => ct,
	base64: () => ps,
	base64url: () => vs,
	bigint: () => ws,
	boolean: () => Fr,
	catch: () => _i,
	check: () => ed,
	cidrv4: () => ms,
	cidrv6: () => fs,
	codec: () => qs,
	cuid: () => is,
	cuid2: () => os,
	custom: () => td,
	date: () => Ns,
	describe: () => nd,
	discriminatedUnion: () => Rs,
	e164: () => gs,
	email: () => Wl,
	emoji: () => ns,
	enum: () => vn,
	exactOptional: () => si,
	file: () => Vs,
	float32: () => ks,
	float64: () => Ss,
	function: () => wt,
	guid: () => Xl,
	hash: () => ys,
	hex: () => bs,
	hostname: () => _s,
	httpUrl: () => ts,
	instanceof: () => id,
	int: () => It,
	int32: () => Is,
	int64: () => xs,
	intersection: () => ei,
	invertCodec: () => Ys,
	ipv4: () => ls,
	ipv6: () => ds,
	json: () => ad,
	jwt: () => hs,
	keyof: () => Ps,
	ksuid: () => cs,
	lazy: () => wi,
	literal: () => Gs,
	looseObject: () => As,
	looseRecord: () => Fs,
	mac: () => ss,
	map: () => Js,
	meta: () => rd,
	nan: () => Xs,
	nanoid: () => rs,
	nativeEnum: () => Ks,
	never: () => mn,
	nonoptional: () => gi,
	null: () => Gr,
	nullable: () => Fe,
	nullish: () => Bs,
	number: () => Lr,
	object: () => Ts,
	optional: () => Le,
	partialRecord: () => Ls,
	pipe: () => zt,
	prefault: () => vi,
	preprocess: () => ud,
	promise: () => Qs,
	readonly: () => Si,
	record: () => ri,
	refine: () => Ui,
	set: () => Ms,
	strictObject: () => Es,
	string: () => Ce,
	stringFormat: () => $s,
	stringbool: () => od,
	success: () => Ws,
	superRefine: () => ji,
	symbol: () => Us,
	templateLiteral: () => Hs,
	transform: () => gn,
	tuple: () => ni,
	uint32: () => zs,
	uint64: () => Zs,
	ulid: () => as,
	undefined: () => js,
	union: () => pn,
	unknown: () => pe,
	url: () => es,
	uuid: () => ql,
	uuidv4: () => Yl,
	uuidv6: () => Hl,
	uuidv7: () => Ql,
	void: () => Os,
	xid: () => us,
	xor: () => Cs
});
const to = /* @__PURE__ */ new WeakMap();
function nt(e, n, i) {
	const o = Object.getPrototypeOf(e);
	let t = to.get(o);
	if (t || (t = /* @__PURE__ */ new Set(), to.set(o, t)), !t.has(n)) {
		t.add(n);
		for (const r in i) {
			const a = i[r];
			Object.defineProperty(o, r, {
				configurable: !0,
				enumerable: !1,
				get() {
					const u = a.bind(this);
					return Object.defineProperty(this, r, {
						configurable: !0,
						writable: !0,
						enumerable: !0,
						value: u
					}), u;
				},
				set(u) {
					Object.defineProperty(this, r, {
						configurable: !0,
						writable: !0,
						enumerable: !0,
						value: u
					});
				}
			});
		}
	}
}
const k = d("ZodType", (e, n) => (y.init(e, n), Object.assign(e["~standard"], { jsonSchema: {
	input: Ae(e, "input"),
	output: Ae(e, "output")
} }), e.toJSONSchema = Gc(e, {}), e.def = n, e.type = n.type, Object.defineProperty(e, "_def", { value: n }), e.parse = (i, o) => El(e, i, o, { callee: e.parse }), e.safeParse = (i, o) => Cl(e, i, o), e.parseAsync = async (i, o) => Al(e, i, o, { callee: e.parseAsync }), e.safeParseAsync = async (i, o) => Rl(e, i, o), e.spa = e.safeParseAsync, e.encode = (i, o) => Ll(e, i, o), e.decode = (i, o) => Fl(e, i, o), e.encodeAsync = async (i, o) => Jl(e, i, o), e.decodeAsync = async (i, o) => Ml(e, i, o), e.safeEncode = (i, o) => Kl(e, i, o), e.safeDecode = (i, o) => Gl(e, i, o), e.safeEncodeAsync = async (i, o) => Vl(e, i, o), e.safeDecodeAsync = async (i, o) => Bl(e, i, o), nt(e, "ZodType", {
	check(...i) {
		const o = this.def;
		return this.clone(X(o, { checks: [...o.checks ?? [], ...i.map((t) => typeof t == "function" ? { _zod: {
			check: t,
			def: { check: "custom" },
			onattach: []
		} } : t)] }), { parent: !0 });
	},
	with(...i) {
		return this.check(...i);
	},
	clone(i, o) {
		return G(this, i, o);
	},
	brand() {
		return this;
	},
	register(i, o) {
		return i.add(this, o), this;
	},
	refine(i, o) {
		return this.check(Ui(i, o));
	},
	superRefine(i, o) {
		return this.check(ji(i, o));
	},
	overwrite(i) {
		return this.check(ee(i));
	},
	optional() {
		return Le(this);
	},
	exactOptional() {
		return si(this);
	},
	nullable() {
		return Fe(this);
	},
	nullish() {
		return Le(Fe(this));
	},
	nonoptional(i) {
		return gi(this, i);
	},
	array() {
		return ct(this);
	},
	or(i) {
		return pn([this, i]);
	},
	and(i) {
		return ei(this, i);
	},
	transform(i) {
		return zt(this, gn(i));
	},
	default(i) {
		return fi(this, i);
	},
	prefault(i) {
		return vi(this, i);
	},
	catch(i) {
		return _i(this, i);
	},
	pipe(i) {
		return zt(this, i);
	},
	readonly() {
		return Si(this);
	},
	describe(i) {
		const o = this.clone();
		return M.add(o, { description: i }), o;
	},
	meta(...i) {
		if (i.length === 0) return M.get(this);
		const o = this.clone();
		return M.add(o, i[0]), o;
	},
	isOptional() {
		return this.safeParse(void 0).success;
	},
	isNullable() {
		return this.safeParse(null).success;
	},
	apply(i) {
		return i(this);
	}
}), Object.defineProperty(e, "description", {
	get() {
		return M.get(e)?.description;
	},
	configurable: !0
}), e)), Bt = d("_ZodString", (e, n) => {
	Ye.init(e, n), k.init(e, n), e._zod.processJSONSchema = (o, t, r) => Vc(e, o, t, r);
	const i = e._zod.bag;
	e.format = i.format ?? null, e.minLength = i.minimum ?? null, e.maxLength = i.maximum ?? null, nt(e, "_ZodString", {
		regex(...o) {
			return this.check(Tt(...o));
		},
		includes(...o) {
			return this.check(Ct(...o));
		},
		startsWith(...o) {
			return this.check(Rt(...o));
		},
		endsWith(...o) {
			return this.check(Lt(...o));
		},
		min(...o) {
			return this.check(fe(...o));
		},
		max(...o) {
			return this.check(Qe(...o));
		},
		length(...o) {
			return this.check(et(...o));
		},
		nonempty(...o) {
			return this.check(fe(1, ...o));
		},
		lowercase(o) {
			return this.check(Et(o));
		},
		uppercase(o) {
			return this.check(At(o));
		},
		trim() {
			return this.check(Mt());
		},
		normalize(...o) {
			return this.check(Jt(...o));
		},
		toLowerCase() {
			return this.check(Kt());
		},
		toUpperCase() {
			return this.check(Gt());
		},
		slugify() {
			return this.check(Vt());
		}
	});
}), rt = d("ZodString", (e, n) => {
	Ye.init(e, n), Bt.init(e, n), e.email = (i) => e.check(cr(Wt, i)), e.url = (i) => e.check(Pt(it, i)), e.jwt = (i) => e.check(xr(sn, i)), e.emoji = (i) => e.check(fr(Xt, i)), e.guid = (i) => e.check(St(Re, i)), e.uuid = (i) => e.check(lr(B, i)), e.uuidv4 = (i) => e.check(sr(B, i)), e.uuidv6 = (i) => e.check(dr(B, i)), e.uuidv7 = (i) => e.check(mr(B, i)), e.nanoid = (i) => e.check(pr(qt, i)), e.guid = (i) => e.check(St(Re, i)), e.cuid = (i) => e.check(vr(Yt, i)), e.cuid2 = (i) => e.check(gr(Ht, i)), e.ulid = (i) => e.check(hr(Qt, i)), e.base64 = (i) => e.check(Ir(un, i)), e.base64url = (i) => e.check(zr(cn, i)), e.xid = (i) => e.check($r(en, i)), e.ksuid = (i) => e.check(_r(tn, i)), e.ipv4 = (i) => e.check(br(nn, i)), e.ipv6 = (i) => e.check(yr(rn, i)), e.cidrv4 = (i) => e.check(kr(on, i)), e.cidrv6 = (i) => e.check(Sr(an, i)), e.e164 = (i) => e.check(wr(ln, i)), e.datetime = (i) => e.check(Dl(i)), e.date = (i) => e.check(Ol(i)), e.time = (i) => e.check(Nl(i)), e.duration = (i) => e.check(Pl(i));
});
function Ce(e) {
	return oc(rt, e);
}
const Z = d("ZodStringFormat", (e, n) => {
	x.init(e, n), Bt.init(e, n);
}), Wt = d("ZodEmail", (e, n) => {
	Fa.init(e, n), Z.init(e, n);
});
function Wl(e) {
	return cr(Wt, e);
}
const Re = d("ZodGUID", (e, n) => {
	Ra.init(e, n), Z.init(e, n);
});
function Xl(e) {
	return St(Re, e);
}
const B = d("ZodUUID", (e, n) => {
	La.init(e, n), Z.init(e, n);
});
function ql(e) {
	return lr(B, e);
}
function Yl(e) {
	return sr(B, e);
}
function Hl(e) {
	return dr(B, e);
}
function Ql(e) {
	return mr(B, e);
}
const it = d("ZodURL", (e, n) => {
	Ja.init(e, n), Z.init(e, n);
});
function es(e) {
	return Pt(it, e);
}
function ts(e) {
	return Pt(it, {
		protocol: Xn,
		hostname: na,
		...p(e)
	});
}
const Xt = d("ZodEmoji", (e, n) => {
	Ma.init(e, n), Z.init(e, n);
});
function ns(e) {
	return fr(Xt, e);
}
const qt = d("ZodNanoID", (e, n) => {
	Ka.init(e, n), Z.init(e, n);
});
function rs(e) {
	return pr(qt, e);
}
const Yt = d("ZodCUID", (e, n) => {
	Ga.init(e, n), Z.init(e, n);
});
function is(e) {
	return vr(Yt, e);
}
const Ht = d("ZodCUID2", (e, n) => {
	Va.init(e, n), Z.init(e, n);
});
function os(e) {
	return gr(Ht, e);
}
const Qt = d("ZodULID", (e, n) => {
	Ba.init(e, n), Z.init(e, n);
});
function as(e) {
	return hr(Qt, e);
}
const en = d("ZodXID", (e, n) => {
	Wa.init(e, n), Z.init(e, n);
});
function us(e) {
	return $r(en, e);
}
const tn = d("ZodKSUID", (e, n) => {
	Xa.init(e, n), Z.init(e, n);
});
function cs(e) {
	return _r(tn, e);
}
const nn = d("ZodIPv4", (e, n) => {
	eu.init(e, n), Z.init(e, n);
});
function ls(e) {
	return br(nn, e);
}
const Rr = d("ZodMAC", (e, n) => {
	nu.init(e, n), Z.init(e, n);
});
function ss(e) {
	return uc(Rr, e);
}
const rn = d("ZodIPv6", (e, n) => {
	tu.init(e, n), Z.init(e, n);
});
function ds(e) {
	return yr(rn, e);
}
const on = d("ZodCIDRv4", (e, n) => {
	ru.init(e, n), Z.init(e, n);
});
function ms(e) {
	return kr(on, e);
}
const an = d("ZodCIDRv6", (e, n) => {
	iu.init(e, n), Z.init(e, n);
});
function fs(e) {
	return Sr(an, e);
}
const un = d("ZodBase64", (e, n) => {
	ou.init(e, n), Z.init(e, n);
});
function ps(e) {
	return Ir(un, e);
}
const cn = d("ZodBase64URL", (e, n) => {
	uu.init(e, n), Z.init(e, n);
});
function vs(e) {
	return zr(cn, e);
}
const ln = d("ZodE164", (e, n) => {
	cu.init(e, n), Z.init(e, n);
});
function gs(e) {
	return wr(ln, e);
}
const sn = d("ZodJWT", (e, n) => {
	su.init(e, n), Z.init(e, n);
});
function hs(e) {
	return xr(sn, e);
}
const Oe = d("ZodCustomStringFormat", (e, n) => {
	du.init(e, n), Z.init(e, n);
});
function $s(e, n, i = {}) {
	return tt(Oe, e, n, i);
}
function _s(e) {
	return tt(Oe, "hostname", ta, e);
}
function bs(e) {
	return tt(Oe, "hex", ha, e);
}
function ys(e, n) {
	const i = `${e}_${n?.enc ?? "hex"}`, o = Bn[i];
	if (!o) throw new Error(`Unrecognized hash format: ${i}`);
	return tt(Oe, i, o, n);
}
const ot = d("ZodNumber", (e, n) => {
	er.init(e, n), k.init(e, n), e._zod.processJSONSchema = (o, t, r) => Bc(e, o, t, r), nt(e, "ZodNumber", {
		gt(o, t) {
			return this.check(ie(o, t));
		},
		gte(o, t) {
			return this.check(C(o, t));
		},
		min(o, t) {
			return this.check(C(o, t));
		},
		lt(o, t) {
			return this.check(re(o, t));
		},
		lte(o, t) {
			return this.check(K(o, t));
		},
		max(o, t) {
			return this.check(K(o, t));
		},
		int(o) {
			return this.check(It(o));
		},
		safe(o) {
			return this.check(It(o));
		},
		positive(o) {
			return this.check(ie(0, o));
		},
		nonnegative(o) {
			return this.check(C(0, o));
		},
		negative(o) {
			return this.check(re(0, o));
		},
		nonpositive(o) {
			return this.check(K(0, o));
		},
		multipleOf(o, t) {
			return this.check(Ie(o, t));
		},
		step(o, t) {
			return this.check(Ie(o, t));
		},
		finite() {
			return this;
		}
	});
	const i = e._zod.bag;
	e.minValue = Math.max(i.minimum ?? Number.NEGATIVE_INFINITY, i.exclusiveMinimum ?? Number.NEGATIVE_INFINITY) ?? null, e.maxValue = Math.min(i.maximum ?? Number.POSITIVE_INFINITY, i.exclusiveMaximum ?? Number.POSITIVE_INFINITY) ?? null, e.isInt = (i.format ?? "").includes("int") || Number.isSafeInteger(i.multipleOf ?? .5), e.isFinite = !0, e.format = i.format ?? null;
});
function Lr(e) {
	return fc(ot, e);
}
const ge = d("ZodNumberFormat", (e, n) => {
	mu.init(e, n), ot.init(e, n);
});
function It(e) {
	return vc(ge, e);
}
function ks(e) {
	return gc(ge, e);
}
function Ss(e) {
	return hc(ge, e);
}
function Is(e) {
	return $c(ge, e);
}
function zs(e) {
	return _c(ge, e);
}
const at = d("ZodBoolean", (e, n) => {
	tr.init(e, n), k.init(e, n), e._zod.processJSONSchema = (i, o, t) => Wc(e, i, o, t);
});
function Fr(e) {
	return bc(at, e);
}
const ut = d("ZodBigInt", (e, n) => {
	nr.init(e, n), k.init(e, n), e._zod.processJSONSchema = (o, t, r) => Xc(e, o, t, r), e.gte = (o, t) => e.check(C(o, t)), e.min = (o, t) => e.check(C(o, t)), e.gt = (o, t) => e.check(ie(o, t)), e.gte = (o, t) => e.check(C(o, t)), e.min = (o, t) => e.check(C(o, t)), e.lt = (o, t) => e.check(re(o, t)), e.lte = (o, t) => e.check(K(o, t)), e.max = (o, t) => e.check(K(o, t)), e.positive = (o) => e.check(ie(BigInt(0), o)), e.negative = (o) => e.check(re(BigInt(0), o)), e.nonpositive = (o) => e.check(K(BigInt(0), o)), e.nonnegative = (o) => e.check(C(BigInt(0), o)), e.multipleOf = (o, t) => e.check(Ie(o, t));
	const i = e._zod.bag;
	e.minValue = i.minimum ?? null, e.maxValue = i.maximum ?? null, e.format = i.format ?? null;
});
function ws(e) {
	return kc(ut, e);
}
const dn = d("ZodBigIntFormat", (e, n) => {
	fu.init(e, n), ut.init(e, n);
});
function xs(e) {
	return Ic(dn, e);
}
function Zs(e) {
	return zc(dn, e);
}
const Jr = d("ZodSymbol", (e, n) => {
	pu.init(e, n), k.init(e, n), e._zod.processJSONSchema = (i, o, t) => qc(e, i, o, t);
});
function Us(e) {
	return wc(Jr, e);
}
const Mr = d("ZodUndefined", (e, n) => {
	vu.init(e, n), k.init(e, n), e._zod.processJSONSchema = (i, o, t) => Hc(e, i, o, t);
});
function js(e) {
	return xc(Mr, e);
}
const Kr = d("ZodNull", (e, n) => {
	gu.init(e, n), k.init(e, n), e._zod.processJSONSchema = (i, o, t) => Yc(e, i, o, t);
});
function Gr(e) {
	return Zc(Kr, e);
}
const Vr = d("ZodAny", (e, n) => {
	hu.init(e, n), k.init(e, n), e._zod.processJSONSchema = (i, o, t) => void 0;
});
function Ds() {
	return Uc(Vr);
}
const Br = d("ZodUnknown", (e, n) => {
	$u.init(e, n), k.init(e, n), e._zod.processJSONSchema = (i, o, t) => void 0;
});
function pe() {
	return jc(Br);
}
const Wr = d("ZodNever", (e, n) => {
	_u.init(e, n), k.init(e, n), e._zod.processJSONSchema = (i, o, t) => el(e, i, o, t);
});
function mn(e) {
	return Dc(Wr, e);
}
const Xr = d("ZodVoid", (e, n) => {
	bu.init(e, n), k.init(e, n), e._zod.processJSONSchema = (i, o, t) => Qc(e, i, o, t);
});
function Os(e) {
	return Oc(Xr, e);
}
const fn = d("ZodDate", (e, n) => {
	yu.init(e, n), k.init(e, n), e._zod.processJSONSchema = (o, t, r) => rl(e, o, t, r), e.min = (o, t) => e.check(C(o, t)), e.max = (o, t) => e.check(K(o, t));
	const i = e._zod.bag;
	e.minDate = i.minimum ? new Date(i.minimum) : null, e.maxDate = i.maximum ? new Date(i.maximum) : null;
});
function Ns(e) {
	return Nc(fn, e);
}
const qr = d("ZodArray", (e, n) => {
	ku.init(e, n), k.init(e, n), e._zod.processJSONSchema = (i, o, t) => vl(e, i, o, t), e.element = n.element, nt(e, "ZodArray", {
		min(i, o) {
			return this.check(fe(i, o));
		},
		nonempty(i) {
			return this.check(fe(1, i));
		},
		max(i, o) {
			return this.check(Qe(i, o));
		},
		length(i, o) {
			return this.check(et(i, o));
		},
		unwrap() {
			return this.element;
		}
	});
});
function ct(e, n) {
	return Ec(qr, e, n);
}
function Ps(e) {
	const n = e._zod.def.shape;
	return vn(Object.keys(n));
}
const lt = d("ZodObject", (e, n) => {
	wu.init(e, n), k.init(e, n), e._zod.processJSONSchema = (i, o, t) => gl(e, i, o, t), S(e, "shape", () => n.shape), nt(e, "ZodObject", {
		keyof() {
			return vn(Object.keys(this._zod.def.shape));
		},
		catchall(i) {
			return this.clone({
				...this._zod.def,
				catchall: i
			});
		},
		passthrough() {
			return this.clone({
				...this._zod.def,
				catchall: pe()
			});
		},
		loose() {
			return this.clone({
				...this._zod.def,
				catchall: pe()
			});
		},
		strict() {
			return this.clone({
				...this._zod.def,
				catchall: mn()
			});
		},
		strip() {
			return this.clone({
				...this._zod.def,
				catchall: void 0
			});
		},
		extend(i) {
			return Io(this, i);
		},
		safeExtend(i) {
			return zo(this, i);
		},
		merge(i) {
			return wo(this, i);
		},
		pick(i) {
			return ko(this, i);
		},
		omit(i) {
			return So(this, i);
		},
		partial(...i) {
			return xo(hn, this, i[0]);
		},
		required(...i) {
			return Zo($n, this, i[0]);
		}
	});
});
function Ts(e, n) {
	return new lt({
		type: "object",
		shape: e ?? {},
		...p(n)
	});
}
function Es(e, n) {
	return new lt({
		type: "object",
		shape: e,
		catchall: mn(),
		...p(n)
	});
}
function As(e, n) {
	return new lt({
		type: "object",
		shape: e,
		catchall: pe(),
		...p(n)
	});
}
const st = d("ZodUnion", (e, n) => {
	Nt.init(e, n), k.init(e, n), e._zod.processJSONSchema = (i, o, t) => Nr(e, i, o, t), e.options = n.options;
});
function pn(e, n) {
	return new st({
		type: "union",
		options: e,
		...p(n)
	});
}
const Yr = d("ZodXor", (e, n) => {
	st.init(e, n), xu.init(e, n), e._zod.processJSONSchema = (i, o, t) => Nr(e, i, o, t), e.options = n.options;
});
function Cs(e, n) {
	return new Yr({
		type: "union",
		options: e,
		inclusive: !1,
		...p(n)
	});
}
const Hr = d("ZodDiscriminatedUnion", (e, n) => {
	st.init(e, n), Zu.init(e, n);
});
function Rs(e, n, i) {
	return new Hr({
		type: "union",
		options: n,
		discriminator: e,
		...p(i)
	});
}
const Qr = d("ZodIntersection", (e, n) => {
	Uu.init(e, n), k.init(e, n), e._zod.processJSONSchema = (i, o, t) => hl(e, i, o, t);
});
function ei(e, n) {
	return new Qr({
		type: "intersection",
		left: e,
		right: n
	});
}
const ti = d("ZodTuple", (e, n) => {
	rr.init(e, n), k.init(e, n), e._zod.processJSONSchema = (i, o, t) => $l(e, i, o, t), e.rest = (i) => e.clone({
		...e._zod.def,
		rest: i
	});
});
function ni(e, n, i) {
	const o = n instanceof y;
	return new ti({
		type: "tuple",
		items: e,
		rest: o ? n : null,
		...p(o ? i : n)
	});
}
const Ze = d("ZodRecord", (e, n) => {
	ju.init(e, n), k.init(e, n), e._zod.processJSONSchema = (i, o, t) => _l(e, i, o, t), e.keyType = n.keyType, e.valueType = n.valueType;
});
function ri(e, n, i) {
	return !n || !n._zod ? new Ze({
		type: "record",
		keyType: Ce(),
		valueType: e,
		...p(n)
	}) : new Ze({
		type: "record",
		keyType: e,
		valueType: n,
		...p(i)
	});
}
function Ls(e, n, i) {
	const o = G(e);
	return o._zod.values = void 0, new Ze({
		type: "record",
		keyType: o,
		valueType: n,
		...p(i)
	});
}
function Fs(e, n, i) {
	return new Ze({
		type: "record",
		keyType: e,
		valueType: n,
		mode: "loose",
		...p(i)
	});
}
const ii = d("ZodMap", (e, n) => {
	Du.init(e, n), k.init(e, n), e._zod.processJSONSchema = (i, o, t) => fl(e, i, o, t), e.keyType = n.keyType, e.valueType = n.valueType, e.min = (...i) => e.check(oe(...i)), e.nonempty = (i) => e.check(oe(1, i)), e.max = (...i) => e.check(De(...i)), e.size = (...i) => e.check(He(...i));
});
function Js(e, n, i) {
	return new ii({
		type: "map",
		keyType: e,
		valueType: n,
		...p(i)
	});
}
const oi = d("ZodSet", (e, n) => {
	Ou.init(e, n), k.init(e, n), e._zod.processJSONSchema = (i, o, t) => pl(e, i, o, t), e.min = (...i) => e.check(oe(...i)), e.nonempty = (i) => e.check(oe(1, i)), e.max = (...i) => e.check(De(...i)), e.size = (...i) => e.check(He(...i));
});
function Ms(e, n) {
	return new oi({
		type: "set",
		valueType: e,
		...p(n)
	});
}
const Ue = d("ZodEnum", (e, n) => {
	Nu.init(e, n), k.init(e, n), e._zod.processJSONSchema = (o, t, r) => il(e, o, t, r), e.enum = n.entries, e.options = Object.values(n.entries);
	const i = new Set(Object.keys(n.entries));
	e.extract = (o, t) => {
		const r = {};
		for (const a of o) if (i.has(a)) r[a] = n.entries[a];
		else throw new Error(`Key ${a} not found in enum`);
		return new Ue({
			...n,
			checks: [],
			...p(t),
			entries: r
		});
	}, e.exclude = (o, t) => {
		const r = { ...n.entries };
		for (const a of o) if (i.has(a)) delete r[a];
		else throw new Error(`Key ${a} not found in enum`);
		return new Ue({
			...n,
			checks: [],
			...p(t),
			entries: r
		});
	};
});
function vn(e, n) {
	return new Ue({
		type: "enum",
		entries: Array.isArray(e) ? Object.fromEntries(e.map((i) => [i, i])) : e,
		...p(n)
	});
}
function Ks(e, n) {
	return new Ue({
		type: "enum",
		entries: e,
		...p(n)
	});
}
const ai = d("ZodLiteral", (e, n) => {
	Pu.init(e, n), k.init(e, n), e._zod.processJSONSchema = (i, o, t) => ol(e, i, o, t), e.values = new Set(n.values), Object.defineProperty(e, "value", { get() {
		if (n.values.length > 1) throw new Error("This schema contains multiple valid literal values. Use `.values` instead.");
		return n.values[0];
	} });
});
function Gs(e, n) {
	return new ai({
		type: "literal",
		values: Array.isArray(e) ? e : [e],
		...p(n)
	});
}
const ui = d("ZodFile", (e, n) => {
	Tu.init(e, n), k.init(e, n), e._zod.processJSONSchema = (i, o, t) => cl(e, i, o, t), e.min = (i, o) => e.check(oe(i, o)), e.max = (i, o) => e.check(De(i, o)), e.mime = (i, o) => e.check(Ft(Array.isArray(i) ? i : [i], o));
});
function Vs(e) {
	return Ac(ui, e);
}
const ci = d("ZodTransform", (e, n) => {
	Eu.init(e, n), k.init(e, n), e._zod.processJSONSchema = (i, o, t) => ml(e, i, o, t), e._zod.parse = (i, o) => {
		if (o.direction === "backward") throw new Zt(e.constructor.name);
		i.addIssue = (r) => {
			if (typeof r == "string") i.issues.push(ke(r, i.value, n));
			else {
				const a = r;
				a.fatal && (a.continue = !1), a.code ?? (a.code = "custom"), a.input ?? (a.input = i.value), a.inst ?? (a.inst = e), i.issues.push(ke(a));
			}
		};
		const t = n.transform(i.value, i);
		return t instanceof Promise ? t.then((r) => (i.value = r, i.fallback = !0, i)) : (i.value = t, i.fallback = !0, i);
	};
});
function gn(e) {
	return new ci({
		type: "transform",
		transform: e
	});
}
const hn = d("ZodOptional", (e, n) => {
	ir.init(e, n), k.init(e, n), e._zod.processJSONSchema = (i, o, t) => Pr(e, i, o, t), e.unwrap = () => e._zod.def.innerType;
});
function Le(e) {
	return new hn({
		type: "optional",
		innerType: e
	});
}
const li = d("ZodExactOptional", (e, n) => {
	Au.init(e, n), k.init(e, n), e._zod.processJSONSchema = (i, o, t) => Pr(e, i, o, t), e.unwrap = () => e._zod.def.innerType;
});
function si(e) {
	return new li({
		type: "optional",
		innerType: e
	});
}
const di = d("ZodNullable", (e, n) => {
	Cu.init(e, n), k.init(e, n), e._zod.processJSONSchema = (i, o, t) => bl(e, i, o, t), e.unwrap = () => e._zod.def.innerType;
});
function Fe(e) {
	return new di({
		type: "nullable",
		innerType: e
	});
}
function Bs(e) {
	return Le(Fe(e));
}
const mi = d("ZodDefault", (e, n) => {
	Ru.init(e, n), k.init(e, n), e._zod.processJSONSchema = (i, o, t) => kl(e, i, o, t), e.unwrap = () => e._zod.def.innerType, e.removeDefault = e.unwrap;
});
function fi(e, n) {
	return new mi({
		type: "default",
		innerType: e,
		get defaultValue() {
			return typeof n == "function" ? n() : jt(n);
		}
	});
}
const pi = d("ZodPrefault", (e, n) => {
	Lu.init(e, n), k.init(e, n), e._zod.processJSONSchema = (i, o, t) => Sl(e, i, o, t), e.unwrap = () => e._zod.def.innerType;
});
function vi(e, n) {
	return new pi({
		type: "prefault",
		innerType: e,
		get defaultValue() {
			return typeof n == "function" ? n() : jt(n);
		}
	});
}
const $n = d("ZodNonOptional", (e, n) => {
	Fu.init(e, n), k.init(e, n), e._zod.processJSONSchema = (i, o, t) => yl(e, i, o, t), e.unwrap = () => e._zod.def.innerType;
});
function gi(e, n) {
	return new $n({
		type: "nonoptional",
		innerType: e,
		...p(n)
	});
}
const hi = d("ZodSuccess", (e, n) => {
	Ju.init(e, n), k.init(e, n), e._zod.processJSONSchema = (i, o, t) => ll(e, i, o, t), e.unwrap = () => e._zod.def.innerType;
});
function Ws(e) {
	return new hi({
		type: "success",
		innerType: e
	});
}
const $i = d("ZodCatch", (e, n) => {
	Mu.init(e, n), k.init(e, n), e._zod.processJSONSchema = (i, o, t) => Il(e, i, o, t), e.unwrap = () => e._zod.def.innerType, e.removeCatch = e.unwrap;
});
function _i(e, n) {
	return new $i({
		type: "catch",
		innerType: e,
		catchValue: typeof n == "function" ? n : () => n
	});
}
const bi = d("ZodNaN", (e, n) => {
	Ku.init(e, n), k.init(e, n), e._zod.processJSONSchema = (i, o, t) => al(e, i, o, t);
});
function Xs(e) {
	return Tc(bi, e);
}
const dt = d("ZodPipe", (e, n) => {
	or.init(e, n), k.init(e, n), e._zod.processJSONSchema = (i, o, t) => zl(e, i, o, t), e.in = n.in, e.out = n.out;
});
function zt(e, n) {
	return new dt({
		type: "pipe",
		in: e,
		out: n
	});
}
const mt = d("ZodCodec", (e, n) => {
	dt.init(e, n), ar.init(e, n);
});
function qs(e, n, i) {
	return new mt({
		type: "pipe",
		in: e,
		out: n,
		transform: i.decode,
		reverseTransform: i.encode
	});
}
function Ys(e) {
	const n = e._zod.def;
	return new mt({
		type: "pipe",
		in: n.out,
		out: n.in,
		transform: n.reverseTransform,
		reverseTransform: n.transform
	});
}
const yi = d("ZodPreprocess", (e, n) => {
	dt.init(e, n), Gu.init(e, n);
}), ki = d("ZodReadonly", (e, n) => {
	Vu.init(e, n), k.init(e, n), e._zod.processJSONSchema = (i, o, t) => wl(e, i, o, t), e.unwrap = () => e._zod.def.innerType;
});
function Si(e) {
	return new ki({
		type: "readonly",
		innerType: e
	});
}
const Ii = d("ZodTemplateLiteral", (e, n) => {
	Bu.init(e, n), k.init(e, n), e._zod.processJSONSchema = (i, o, t) => ul(e, i, o, t);
});
function Hs(e, n) {
	return new Ii({
		type: "template_literal",
		parts: e,
		...p(n)
	});
}
const zi = d("ZodLazy", (e, n) => {
	qu.init(e, n), k.init(e, n), e._zod.processJSONSchema = (i, o, t) => Zl(e, i, o, t), e.unwrap = () => e._zod.def.getter();
});
function wi(e) {
	return new zi({
		type: "lazy",
		getter: e
	});
}
const xi = d("ZodPromise", (e, n) => {
	Xu.init(e, n), k.init(e, n), e._zod.processJSONSchema = (i, o, t) => xl(e, i, o, t), e.unwrap = () => e._zod.def.innerType;
});
function Qs(e) {
	return new xi({
		type: "promise",
		innerType: e
	});
}
const Zi = d("ZodFunction", (e, n) => {
	Wu.init(e, n), k.init(e, n), e._zod.processJSONSchema = (i, o, t) => dl(e, i, o, t);
});
function wt(e) {
	return new Zi({
		type: "function",
		input: Array.isArray(e?.input) ? ni(e?.input) : e?.input ?? ct(pe()),
		output: e?.output ?? pe()
	});
}
const ft = d("ZodCustom", (e, n) => {
	Yu.init(e, n), k.init(e, n), e._zod.processJSONSchema = (i, o, t) => sl(e, i, o, t);
});
function ed(e) {
	const n = new D({ check: "custom" });
	return n._zod.check = e, n;
}
function td(e, n) {
	return Cc(ft, e ?? (() => !0), n);
}
function Ui(e, n = {}) {
	return Rc(ft, e, n);
}
function ji(e, n) {
	return Lc(e, n);
}
const nd = Jc, rd = Mc;
function id(e, n = {}) {
	const i = new ft({
		type: "custom",
		check: "custom",
		fn: (o) => o instanceof e,
		abort: !0,
		...p(n)
	});
	return i._zod.bag.Class = e, i._zod.check = (o) => {
		o.value instanceof e || o.issues.push({
			code: "invalid_type",
			expected: e.name,
			input: o.value,
			inst: i,
			path: [...i._zod.def.path ?? []]
		});
	}, i;
}
const od = (...e) => Kc({
	Codec: mt,
	Boolean: at,
	String: rt
}, ...e);
function ad(e) {
	const n = wi(() => pn([
		Ce(e),
		Lr(),
		Fr(),
		Gr(),
		ct(n),
		ri(Ce(), n)
	]));
	return n;
}
function ud(e, n) {
	return new yi({
		type: "pipe",
		in: gn(e),
		out: n
	});
}
const Ep = {
	invalid_type: "invalid_type",
	too_big: "too_big",
	too_small: "too_small",
	invalid_format: "invalid_format",
	not_multiple_of: "not_multiple_of",
	unrecognized_keys: "unrecognized_keys",
	invalid_union: "invalid_union",
	invalid_key: "invalid_key",
	invalid_element: "invalid_element",
	invalid_value: "invalid_value",
	custom: "custom"
};
function Ap(e) {
	P({ customError: e });
}
function Cp() {
	return P().customError;
}
var Un;
Un || (Un = {});
const $ = {
	...Tp,
	...Np,
	iso: jl
}, Rp = new Set([
	"$schema",
	"$ref",
	"$defs",
	"definitions",
	"$id",
	"id",
	"$comment",
	"$anchor",
	"$vocabulary",
	"$dynamicRef",
	"$dynamicAnchor",
	"type",
	"enum",
	"const",
	"anyOf",
	"oneOf",
	"allOf",
	"not",
	"properties",
	"required",
	"additionalProperties",
	"patternProperties",
	"propertyNames",
	"minProperties",
	"maxProperties",
	"items",
	"prefixItems",
	"additionalItems",
	"minItems",
	"maxItems",
	"uniqueItems",
	"contains",
	"minContains",
	"maxContains",
	"minLength",
	"maxLength",
	"pattern",
	"format",
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"multipleOf",
	"description",
	"default",
	"contentEncoding",
	"contentMediaType",
	"contentSchema",
	"unevaluatedItems",
	"unevaluatedProperties",
	"if",
	"then",
	"else",
	"dependentSchemas",
	"dependentRequired",
	"nullable",
	"readOnly"
]);
function Lp(e, n) {
	const i = e.$schema;
	return i === "https://json-schema.org/draft/2020-12/schema" ? "draft-2020-12" : i === "http://json-schema.org/draft-07/schema#" ? "draft-7" : i === "http://json-schema.org/draft-04/schema#" ? "draft-4" : n ?? "draft-2020-12";
}
function Fp(e, n) {
	if (!e.startsWith("#")) throw new Error("External $ref is not supported, only local refs (#/...) are allowed");
	const i = e.slice(1).split("/").filter(Boolean);
	if (i.length === 0) return n.rootSchema;
	const o = n.version === "draft-2020-12" ? "$defs" : "definitions";
	if (i[0] === o) {
		const t = i[1];
		if (!t || !n.defs[t]) throw new Error(`Reference not found: ${e}`);
		return n.defs[t];
	}
	throw new Error(`Reference not found: ${e}`);
}
function cd(e, n) {
	if (e.not !== void 0) {
		if (typeof e.not == "object" && Object.keys(e.not).length === 0) return $.never();
		throw new Error("not is not supported in Zod (except { not: {} } for never)");
	}
	if (e.unevaluatedItems !== void 0) throw new Error("unevaluatedItems is not supported");
	if (e.unevaluatedProperties !== void 0) throw new Error("unevaluatedProperties is not supported");
	if (e.if !== void 0 || e.then !== void 0 || e.else !== void 0) throw new Error("Conditional schemas (if/then/else) are not supported");
	if (e.dependentSchemas !== void 0 || e.dependentRequired !== void 0) throw new Error("dependentSchemas and dependentRequired are not supported");
	if (e.$ref) {
		const t = e.$ref;
		if (n.refs.has(t)) return n.refs.get(t);
		if (n.processing.has(t)) return $.lazy(() => {
			if (!n.refs.has(t)) throw new Error(`Circular reference not resolved: ${t}`);
			return n.refs.get(t);
		});
		n.processing.add(t);
		const r = T(Fp(t, n), n);
		return n.refs.set(t, r), n.processing.delete(t), r;
	}
	if (e.enum !== void 0) {
		const t = e.enum;
		if (n.version === "openapi-3.0" && e.nullable === !0 && t.length === 1 && t[0] === null) return $.null();
		if (t.length === 0) return $.never();
		if (t.length === 1) return $.literal(t[0]);
		if (t.every((a) => typeof a == "string")) return $.enum(t);
		const r = t.map((a) => $.literal(a));
		return r.length < 2 ? r[0] : $.union([
			r[0],
			r[1],
			...r.slice(2)
		]);
	}
	if (e.const !== void 0) return $.literal(e.const);
	const i = e.type;
	if (Array.isArray(i)) {
		const t = i.map((r) => cd({
			...e,
			type: r
		}, n));
		return t.length === 0 ? $.never() : t.length === 1 ? t[0] : $.union(t);
	}
	if (!i) return $.any();
	let o;
	switch (i) {
		case "string": {
			let t = $.string();
			if (e.format) {
				const r = e.format;
				r === "email" ? t = t.check($.email()) : r === "uri" || r === "uri-reference" ? t = t.check($.url()) : r === "uuid" || r === "guid" ? t = t.check($.uuid()) : r === "date-time" ? t = t.check($.iso.datetime()) : r === "date" ? t = t.check($.iso.date()) : r === "time" ? t = t.check($.iso.time()) : r === "duration" ? t = t.check($.iso.duration()) : r === "ipv4" ? t = t.check($.ipv4()) : r === "ipv6" ? t = t.check($.ipv6()) : r === "mac" ? t = t.check($.mac()) : r === "cidr" ? t = t.check($.cidrv4()) : r === "cidr-v6" ? t = t.check($.cidrv6()) : r === "base64" ? t = t.check($.base64()) : r === "base64url" ? t = t.check($.base64url()) : r === "e164" ? t = t.check($.e164()) : r === "jwt" ? t = t.check($.jwt()) : r === "emoji" ? t = t.check($.emoji()) : r === "nanoid" ? t = t.check($.nanoid()) : r === "cuid" ? t = t.check($.cuid()) : r === "cuid2" ? t = t.check($.cuid2()) : r === "ulid" ? t = t.check($.ulid()) : r === "xid" ? t = t.check($.xid()) : r === "ksuid" && (t = t.check($.ksuid()));
			}
			typeof e.minLength == "number" && (t = t.min(e.minLength)), typeof e.maxLength == "number" && (t = t.max(e.maxLength)), e.pattern && (t = t.regex(new RegExp(e.pattern))), o = t;
			break;
		}
		case "number":
		case "integer": {
			let t = i === "integer" ? $.number().int() : $.number();
			typeof e.minimum == "number" && (t = t.min(e.minimum)), typeof e.maximum == "number" && (t = t.max(e.maximum)), typeof e.exclusiveMinimum == "number" ? t = t.gt(e.exclusiveMinimum) : e.exclusiveMinimum === !0 && typeof e.minimum == "number" && (t = t.gt(e.minimum)), typeof e.exclusiveMaximum == "number" ? t = t.lt(e.exclusiveMaximum) : e.exclusiveMaximum === !0 && typeof e.maximum == "number" && (t = t.lt(e.maximum)), typeof e.multipleOf == "number" && (t = t.multipleOf(e.multipleOf)), o = t;
			break;
		}
		case "boolean":
			o = $.boolean();
			break;
		case "null":
			o = $.null();
			break;
		case "object": {
			const t = {}, r = e.properties || {}, a = new Set(e.required || []);
			for (const [l, c] of Object.entries(r)) {
				const s = T(c, n);
				t[l] = a.has(l) ? s : s.optional();
			}
			if (e.propertyNames) {
				const l = T(e.propertyNames, n), c = e.additionalProperties && typeof e.additionalProperties == "object" ? T(e.additionalProperties, n) : $.any();
				if (Object.keys(t).length === 0) {
					o = $.record(l, c);
					break;
				}
				const s = $.object(t).passthrough(), f = $.looseRecord(l, c);
				o = $.intersection(s, f);
				break;
			}
			if (e.patternProperties) {
				const l = e.patternProperties, c = Object.keys(l), s = [];
				for (const m of c) {
					const g = T(l[m], n), I = $.string().regex(new RegExp(m));
					s.push($.looseRecord(I, g));
				}
				const f = [];
				if (Object.keys(t).length > 0 && f.push($.object(t).passthrough()), f.push(...s), f.length === 0) o = $.object({}).passthrough();
				else if (f.length === 1) o = f[0];
				else {
					let m = $.intersection(f[0], f[1]);
					for (let g = 2; g < f.length; g++) m = $.intersection(m, f[g]);
					o = m;
				}
				break;
			}
			const u = $.object(t);
			e.additionalProperties === !1 ? o = u.strict() : typeof e.additionalProperties == "object" ? o = u.catchall(T(e.additionalProperties, n)) : o = u.passthrough();
			break;
		}
		case "array": {
			const t = e.prefixItems, r = e.items;
			if (t && Array.isArray(t)) {
				const a = t.map((l) => T(l, n)), u = r && typeof r == "object" && !Array.isArray(r) ? T(r, n) : void 0;
				u ? o = $.tuple(a).rest(u) : o = $.tuple(a), typeof e.minItems == "number" && (o = o.check($.minLength(e.minItems))), typeof e.maxItems == "number" && (o = o.check($.maxLength(e.maxItems)));
			} else if (Array.isArray(r)) {
				const a = r.map((l) => T(l, n)), u = e.additionalItems && typeof e.additionalItems == "object" ? T(e.additionalItems, n) : void 0;
				u ? o = $.tuple(a).rest(u) : o = $.tuple(a), typeof e.minItems == "number" && (o = o.check($.minLength(e.minItems))), typeof e.maxItems == "number" && (o = o.check($.maxLength(e.maxItems)));
			} else if (r !== void 0) {
				const a = T(r, n);
				let u = $.array(a);
				typeof e.minItems == "number" && (u = u.min(e.minItems)), typeof e.maxItems == "number" && (u = u.max(e.maxItems)), o = u;
			} else o = $.array($.any());
			break;
		}
		default: throw new Error(`Unsupported type: ${i}`);
	}
	return o;
}
function T(e, n) {
	if (typeof e == "boolean") return e ? $.any() : $.never();
	let i = cd(e, n);
	const o = e.type || e.enum !== void 0 || e.const !== void 0;
	if (e.anyOf && Array.isArray(e.anyOf)) {
		const r = e.anyOf.map((u) => T(u, n)), a = $.union(r);
		i = o ? $.intersection(i, a) : a;
	}
	if (e.oneOf && Array.isArray(e.oneOf)) {
		const r = e.oneOf.map((u) => T(u, n)), a = $.xor(r);
		i = o ? $.intersection(i, a) : a;
	}
	if (e.allOf && Array.isArray(e.allOf)) if (e.allOf.length === 0) i = o ? i : $.any();
	else {
		let r = o ? i : T(e.allOf[0], n);
		const a = o ? 0 : 1;
		for (let u = a; u < e.allOf.length; u++) r = $.intersection(r, T(e.allOf[u], n));
		i = r;
	}
	e.nullable === !0 && n.version === "openapi-3.0" && (i = $.nullable(i)), e.readOnly === !0 && (i = $.readonly(i)), e.default !== void 0 && (i = i.default(e.default));
	const t = {};
	for (const r of [
		"$id",
		"id",
		"$comment",
		"$anchor",
		"$vocabulary",
		"$dynamicRef",
		"$dynamicAnchor"
	]) r in e && (t[r] = e[r]);
	for (const r of [
		"contentEncoding",
		"contentMediaType",
		"contentSchema"
	]) r in e && (t[r] = e[r]);
	for (const r of Object.keys(e)) Rp.has(r) || (t[r] = e[r]);
	return Object.keys(t).length > 0 && n.registry.add(i, t), e.description && (i = i.describe(e.description)), i;
}
function Jp(e, n) {
	if (typeof e == "boolean") return e ? $.any() : $.never();
	let i;
	try {
		i = JSON.parse(JSON.stringify(e));
	} catch {
		throw new Error("fromJSONSchema input is not valid JSON (possibly cyclic); use $defs/$ref for recursive schemas");
	}
	const o = {
		version: Lp(i, n?.defaultTarget),
		defs: i.$defs || i.definitions || {},
		refs: /* @__PURE__ */ new Map(),
		processing: /* @__PURE__ */ new Set(),
		rootSchema: i,
		registry: n?.registry ?? M
	};
	return T(i, o);
}
var Mp = W({
	bigint: () => Bp,
	boolean: () => Vp,
	date: () => Wp,
	number: () => Gp,
	string: () => Kp
});
function Kp(e) {
	return ac(rt, e);
}
function Gp(e) {
	return pc(ot, e);
}
function Vp(e) {
	return yc(at, e);
}
function Bp(e) {
	return Sc(ut, e);
}
function Wp(e) {
	return Pc(fn, e);
}
var Xp = W({
	$brand: () => fo,
	$input: () => rc,
	$output: () => nc,
	NEVER: () => mo,
	TimePrecision: () => cc,
	ZodAny: () => Vr,
	ZodArray: () => qr,
	ZodBase64: () => un,
	ZodBase64URL: () => cn,
	ZodBigInt: () => ut,
	ZodBigIntFormat: () => dn,
	ZodBoolean: () => at,
	ZodCIDRv4: () => on,
	ZodCIDRv6: () => an,
	ZodCUID: () => Yt,
	ZodCUID2: () => Ht,
	ZodCatch: () => $i,
	ZodCodec: () => mt,
	ZodCustom: () => ft,
	ZodCustomStringFormat: () => Oe,
	ZodDate: () => fn,
	ZodDefault: () => mi,
	ZodDiscriminatedUnion: () => Hr,
	ZodE164: () => ln,
	ZodEmail: () => Wt,
	ZodEmoji: () => Xt,
	ZodEnum: () => Ue,
	ZodError: () => Pp,
	ZodExactOptional: () => li,
	ZodFile: () => ui,
	ZodFirstPartyTypeKind: () => Un,
	ZodFunction: () => Zi,
	ZodGUID: () => Re,
	ZodIPv4: () => nn,
	ZodIPv6: () => rn,
	ZodISODate: () => Er,
	ZodISODateTime: () => Tr,
	ZodISODuration: () => Cr,
	ZodISOTime: () => Ar,
	ZodIntersection: () => Qr,
	ZodIssueCode: () => Ep,
	ZodJWT: () => sn,
	ZodKSUID: () => tn,
	ZodLazy: () => zi,
	ZodLiteral: () => ai,
	ZodMAC: () => Rr,
	ZodMap: () => ii,
	ZodNaN: () => bi,
	ZodNanoID: () => qt,
	ZodNever: () => Wr,
	ZodNonOptional: () => $n,
	ZodNull: () => Kr,
	ZodNullable: () => di,
	ZodNumber: () => ot,
	ZodNumberFormat: () => ge,
	ZodObject: () => lt,
	ZodOptional: () => hn,
	ZodPipe: () => dt,
	ZodPrefault: () => pi,
	ZodPreprocess: () => yi,
	ZodPromise: () => xi,
	ZodReadonly: () => ki,
	ZodRealError: () => F,
	ZodRecord: () => Ze,
	ZodSet: () => oi,
	ZodString: () => rt,
	ZodStringFormat: () => Z,
	ZodSuccess: () => hi,
	ZodSymbol: () => Jr,
	ZodTemplateLiteral: () => Ii,
	ZodTransform: () => ci,
	ZodTuple: () => ti,
	ZodType: () => k,
	ZodULID: () => Qt,
	ZodURL: () => it,
	ZodUUID: () => B,
	ZodUndefined: () => Mr,
	ZodUnion: () => st,
	ZodUnknown: () => Br,
	ZodVoid: () => Xr,
	ZodXID: () => en,
	ZodXor: () => Yr,
	_ZodString: () => Bt,
	_default: () => fi,
	_function: () => wt,
	any: () => Ds,
	array: () => ct,
	base64: () => ps,
	base64url: () => vs,
	bigint: () => ws,
	boolean: () => Fr,
	catch: () => _i,
	check: () => ed,
	cidrv4: () => ms,
	cidrv6: () => fs,
	clone: () => G,
	codec: () => qs,
	coerce: () => Mp,
	config: () => P,
	core: () => Op,
	cuid: () => is,
	cuid2: () => os,
	custom: () => td,
	date: () => Ns,
	decode: () => Fl,
	decodeAsync: () => Ml,
	describe: () => nd,
	discriminatedUnion: () => Rs,
	e164: () => gs,
	email: () => Wl,
	emoji: () => ns,
	encode: () => Ll,
	encodeAsync: () => Jl,
	endsWith: () => Lt,
	enum: () => vn,
	exactOptional: () => si,
	file: () => Vs,
	flattenError: () => An,
	float32: () => ks,
	float64: () => Ss,
	formatError: () => Cn,
	fromJSONSchema: () => Jp,
	function: () => wt,
	getErrorMap: () => Cp,
	globalRegistry: () => M,
	gt: () => ie,
	gte: () => C,
	guid: () => Xl,
	hash: () => ys,
	hex: () => bs,
	hostname: () => _s,
	httpUrl: () => ts,
	includes: () => Ct,
	instanceof: () => id,
	int: () => It,
	int32: () => Is,
	int64: () => xs,
	intersection: () => ei,
	invertCodec: () => Ys,
	ipv4: () => ls,
	ipv6: () => ds,
	iso: () => jl,
	json: () => ad,
	jwt: () => hs,
	keyof: () => Ps,
	ksuid: () => cs,
	lazy: () => wi,
	length: () => et,
	literal: () => Gs,
	locales: () => tc,
	looseObject: () => As,
	looseRecord: () => Fs,
	lowercase: () => Et,
	lt: () => re,
	lte: () => K,
	mac: () => ss,
	map: () => Js,
	maxLength: () => Qe,
	maxSize: () => De,
	meta: () => rd,
	mime: () => Ft,
	minLength: () => fe,
	minSize: () => oe,
	multipleOf: () => Ie,
	nan: () => Xs,
	nanoid: () => rs,
	nativeEnum: () => Ks,
	negative: () => Ur,
	never: () => mn,
	nonnegative: () => Dr,
	nonoptional: () => gi,
	nonpositive: () => jr,
	normalize: () => Jt,
	null: () => Gr,
	nullable: () => Fe,
	nullish: () => Bs,
	number: () => Lr,
	object: () => Ts,
	optional: () => Le,
	overwrite: () => ee,
	parse: () => El,
	parseAsync: () => Al,
	partialRecord: () => Ls,
	pipe: () => zt,
	positive: () => Zr,
	prefault: () => vi,
	preprocess: () => ud,
	prettifyError: () => To,
	promise: () => Qs,
	property: () => Or,
	readonly: () => Si,
	record: () => ri,
	refine: () => Ui,
	regex: () => Tt,
	regexes: () => Bn,
	registry: () => ur,
	safeDecode: () => Gl,
	safeDecodeAsync: () => Bl,
	safeEncode: () => Kl,
	safeEncodeAsync: () => Vl,
	safeParse: () => Cl,
	safeParseAsync: () => Rl,
	set: () => Ms,
	setErrorMap: () => Ap,
	size: () => He,
	slugify: () => Vt,
	startsWith: () => Rt,
	strictObject: () => Es,
	string: () => Ce,
	stringFormat: () => $s,
	stringbool: () => od,
	success: () => Ws,
	superRefine: () => ji,
	symbol: () => Us,
	templateLiteral: () => Hs,
	toJSONSchema: () => Ul,
	toLowerCase: () => Kt,
	toUpperCase: () => Gt,
	transform: () => gn,
	treeifyError: () => No,
	trim: () => Mt,
	tuple: () => ni,
	uint32: () => zs,
	uint64: () => Zs,
	ulid: () => as,
	undefined: () => js,
	union: () => pn,
	unknown: () => pe,
	uppercase: () => At,
	url: () => es,
	util: () => po,
	uuid: () => ql,
	uuidv4: () => Yl,
	uuidv6: () => Hl,
	uuidv7: () => Ql,
	void: () => Os,
	xid: () => us,
	xor: () => Cs
});
P(Hu());
var h = Xp;
const ld = h.enum(["R", "SR"]), bn = h.enum([
	"blue",
	"purple",
	"yellow"
]), Yp = h.enum(["single", "supply"]), Hp = h.object({
	grade: ld,
	level: h.number(),
	exp: h.number()
}).passthrough(), Qp = h.object({
	blue: h.number(),
	purple: h.number(),
	yellow: h.number()
}).passthrough(), no = h.object({
	start: Hp,
	stock: Qp,
	strategy: Yp.optional(),
	monteCarloRuns: h.number().optional(),
	monteCarloSeed: h.number().optional()
}).passthrough();
h.object({
	endpoint: h.string().trim().url().optional(),
	turnstileSiteKey: h.string().trim().min(1).optional()
}).passthrough();
const ev = h.object({
	phase: h.string(),
	scanned: h.number().optional(),
	total: h.number().nullable().optional()
}).passthrough(), tv = h.discriminatedUnion("type", [h.object({
	type: h.literal("solve"),
	id: h.number(),
	input: no
}).passthrough(), h.object({
	type: h.literal("validate"),
	id: h.number(),
	input: no,
	runs: h.number().optional(),
	seed: h.number().optional()
}).passthrough()]);
h.discriminatedUnion("type", [
	h.object({
		type: h.literal("progress"),
		id: h.number(),
		progress: ev
	}).passthrough(),
	h.object({
		type: h.literal("result"),
		id: h.number(),
		result: h.unknown()
	}).passthrough(),
	h.object({
		type: h.literal("error"),
		id: h.number(),
		message: h.string()
	}).passthrough()
]);
const ro = h.object({
	events: h.number(),
	attempts: h.number(),
	greatSuccesses: h.number(),
	greatSuccessRate: h.number().optional(),
	theoreticalGreatSuccessRate: h.number().optional()
}).passthrough(), yn = h.object({
	attempts: h.number(),
	greatSuccesses: h.number(),
	greatSuccessRate: h.number(),
	theoreticalGreatSuccessRate: h.number()
}).passthrough();
h.object({
	windowDays: h.number(),
	today: h.string(),
	summary: h.object({
		events: h.number(),
		attempts: h.number(),
		greatSuccesses: h.number(),
		greatSuccessRate: h.number(),
		todayEvents: h.number(),
		todayAttempts: h.number(),
		todayGreatSuccesses: h.number(),
		mostUsedKit: bn.nullable(),
		mostUsedKitPieces: h.number()
	}).passthrough(),
	byKit: h.array(ro.extend({
		kit: bn,
		theoreticalGreatSuccessRate: h.number()
	}).passthrough()),
	levelKitStats: h.array(h.object({
		grade: ld,
		level: h.number(),
		kits: h.object({
			blue: yn,
			purple: yn,
			yellow: yn
		}).passthrough()
	}).passthrough()),
	segmentStats: h.array(ro.extend({
		key: h.string(),
		label: h.string(),
		theoreticalGreatSuccessRate: h.number(),
		averageAttempts: h.number()
	}).passthrough()),
	successAttemptDistribution: h.array(h.object({
		kit: bn,
		successAttempt: h.number(),
		events: h.number()
	}).passthrough())
}).passthrough();
const Q = [
	"blue",
	"purple",
	"yellow"
], nv = {
	blue: {
		label: "초심자용 관리 키트",
		shortLabel: "초심자",
		exp: 200
	},
	purple: {
		label: "중급자용 관리 키트",
		shortLabel: "중급자",
		exp: 500
	},
	yellow: {
		label: "상급자용 관리 키트",
		shortLabel: "상급자",
		exp: 1e3
	}
}, jn = {
	R: 1e3,
	SR: 3e3
}, te = {
	blue: 220,
	purple: 88,
	yellow: 44
}, Te = 1e-12, rv = {
	single: .001,
	supply: .01
}, _t = {
	horizon: .5,
	normPower: 3
}, iv = 30, ov = 16, av = (te.blue + 1) * (te.purple + 1) * (te.yellow + 1), uv = 1e3, cv = {
	blue: 0,
	purple: 1,
	yellow: 2
}, io = /* @__PURE__ */ new Map(), sd = "single", lv = {
	single: {
		label: "단일 목표",
		description: "지금 이 소장품을 SR 15로 만들기 위한 최적의 선택"
	},
	supply: {
		label: "수급량 고려",
		description: "SR 15 도달 확률을 크게 깎지 않는 선에서 수급량/보유량을 함께 고려"
	}
}, dd = {
	blue: 473.912,
	purple: 55.808,
	yellow: 24.736
}, sv = {
	R: {
		blue: [
			17.6,
			20.8,
			24,
			27.2,
			40,
			16,
			19.2,
			22.4,
			27.2,
			40,
			14.4,
			17.6,
			22.4,
			27.2,
			40
		],
		purple: [
			55,
			65,
			75,
			85,
			100,
			50,
			60,
			70,
			85,
			100,
			45,
			55,
			70,
			85,
			100
		],
		yellow: [
			100,
			100,
			100,
			100,
			100,
			100,
			100,
			100,
			100,
			100,
			100,
			100,
			100,
			100,
			100
		]
	},
	SR: {
		blue: [
			3.6,
			5.9,
			7.8,
			11.3,
			15,
			2.2,
			3.3,
			4.9,
			7.6,
			12.5,
			1.2,
			2.2,
			3.1,
			4.7,
			10
		],
		purple: [
			11,
			19.8,
			28.7,
			41.3,
			55,
			8,
			12,
			18,
			28,
			50,
			5.4,
			9.9,
			14.4,
			21.6,
			45
		],
		yellow: [
			25,
			40,
			55,
			75,
			100,
			20,
			30,
			45,
			70,
			100,
			15,
			27.5,
			40,
			60,
			100
		]
	}
};
function md(e, n, i) {
	return Math.min(i, Math.max(n, e));
}
function Y(e, n = 3) {
	const i = 10 ** n;
	return Math.round((e + Number.EPSILON) * i) / i;
}
function ae(e) {
	const n = e && e.grade === "SR" ? "SR" : "R", i = Number(e?.level), o = Number.isFinite(i) ? Math.max(0, Math.floor(i)) : 0, t = Math.max(0, Math.floor(Number(e?.exp) || 0));
	return n === "SR" && o >= 15 ? {
		grade: "SR",
		level: 15,
		exp: 0
	} : n === "R" && o >= 15 ? {
		grade: "R",
		level: 15,
		exp: 0
	} : {
		grade: n,
		level: md(o, 0, 14),
		exp: t
	};
}
function he(e) {
	return e.grade === "SR" && e.level >= 15;
}
function $e(e) {
	return e.grade === "R" && e.level >= 15;
}
function ne() {
	return {
		grade: "SR",
		level: 5,
		exp: 0
	};
}
function dv(e) {
	return e < 5 ? 5 : e < 10 ? 10 : 15;
}
function fd(e, n) {
	const i = e.grade;
	let o = e.level, t = e.exp + nv[n].exp;
	const r = jn[i];
	for (; t >= r && o < 15;) if (t -= r, o += 1, o === 5 || o === 10 || o === 15) {
		t = 0;
		break;
	}
	return {
		grade: i,
		level: o,
		exp: t
	};
}
function je(e, n) {
	return he(e) || $e(e) ? {
		probability: 0,
		success: e,
		fail: e
	} : {
		probability: Number(sv[e.grade][n][e.level] || 0) / 100,
		success: {
			grade: e.grade,
			level: dv(e.level),
			exp: 0
		},
		fail: fd(e, n)
	};
}
function be(e) {
	const n = ae(e);
	return n.grade === "SR" && n.level >= 15 ? "SR 15레벨" : `${n.grade} ${n.level}레벨 ${n.exp}exp`;
}
function xt(e) {
	return ((e.grade === "SR" ? 1 : 0) * ov + e.level) * iv + e.exp / 100 | 0;
}
function mv(e) {
	return (e.blue * (te.purple + 1) + e.purple) * (te.yellow + 1) + e.yellow;
}
function oo(e, n) {
	return xt(e) * av + mv(n);
}
function kn(e, n) {
	const i = xt(e) * Q.length + cv[n], o = io.get(i);
	if (typeof o == "number") return o;
	let t = e, r = 0, a = 0;
	for (; !he(t);) {
		if (a += 1, a > uv) return Number.POSITIVE_INFINITY;
		if ($e(t)) {
			t = ne();
			continue;
		}
		t = fd(t, n), r += 1;
	}
	return io.set(i, r), r;
}
function Sn(e, n, i = null) {
	const o = {
		blue: kn(e, "blue"),
		purple: kn(e, "purple"),
		yellow: kn(e, "yellow")
	};
	if (!Number.isFinite(o.blue) || !Number.isFinite(o.purple) || !Number.isFinite(o.yellow)) return i && (i.dynamicCapFallbacks += 1), n;
	const t = {
		blue: Math.min(n.blue, o.blue),
		purple: Math.min(n.purple, o.purple),
		yellow: Math.min(n.yellow, o.yellow)
	}, r = n.blue + n.purple + n.yellow, a = t.blue + t.purple + t.yellow;
	return r > 0 && a <= 0 ? (i && (i.dynamicCapFallbacks += 1), n) : t.blue === n.blue && t.purple === n.purple && t.yellow === n.yellow ? n : (i && (i.dynamicCapReductions += r - a), t);
}
function fv(e) {
	return {
		blue: Math.max(0, Math.floor(Number(e?.blue) || 0)),
		purple: Math.max(0, Math.floor(Number(e?.purple) || 0)),
		yellow: Math.max(0, Math.floor(Number(e?.yellow) || 0))
	};
}
function pv(e) {
	return {
		blue: Math.floor(e.blue / 10),
		purple: Math.floor(e.purple / 10),
		yellow: Math.floor(e.yellow / 10)
	};
}
function Je(e, n) {
	return {
		blue: e.blue - (n === "blue" ? 1 : 0),
		purple: e.purple - (n === "purple" ? 1 : 0),
		yellow: e.yellow - (n === "yellow" ? 1 : 0)
	};
}
function vv(e, n) {
	return {
		blue: e.blue + (n === "blue" ? 10 : 0),
		purple: e.purple + (n === "purple" ? 10 : 0),
		yellow: e.yellow + (n === "yellow" ? 10 : 0)
	};
}
function ao(e, n, i, o) {
	return vv({
		blue: e * n.blue + (1 - e) * i.blue,
		purple: e * n.purple + (1 - e) * i.purple,
		yellow: e * n.yellow + (1 - e) * i.yellow
	}, o);
}
function Dn(e) {
	return Q.reduce((n, i) => n + e[i], 0);
}
function uo(e, n) {
	return Q.reduce((i, o) => {
		const t = Math.max(1, n[o]);
		return i + e[o] / 10 / t;
	}, 0);
}
function co(e) {
	return Q.reduce((n, i) => n + e[i] / dd[i], 0);
}
function lo(e, n) {
	return Q.reduce((i, o) => {
		const t = n[o] + _t.horizon * dd[o];
		return t <= 0 ? Number.POSITIVE_INFINITY : i + (e[o] / t) ** _t.normPower;
	}, 0) ** (1 / _t.normPower);
}
function so(e, n, i) {
	return i !== "supply" ? e : n;
}
function Di(e) {
	return e === "supply" ? "supply" : sd;
}
function pd(e) {
	return rv[Di(e)];
}
function On(e, n, i) {
	return n - e <= pd(i) + Te;
}
function Nn(e, n, i = sd) {
	if (i === "supply") {
		if (Math.abs(e.resourceCost - n.resourceCost) > Te) return e.resourceCost - n.resourceCost;
	} else if (Math.abs(e.pressure - n.pressure) > Te) return e.pressure - n.pressure;
	const o = Dn(e.vector) - Dn(n.vector);
	return Math.abs(o) > Te ? o : n.successProbability - e.successProbability;
}
function gv(e, n, i) {
	if (!e.length) return null;
	const o = e.filter((t) => On(t.successProbability, n, i));
	return (o.length ? o : e).reduce((t, r) => t ? Nn(r, t, i) < 0 ? r : t : r, null);
}
function hv(e, n, i, o) {
	const t = On(e.successProbability, i, o), r = On(n.successProbability, i, o);
	return t !== r ? t ? -1 : 1 : t && r ? Nn(e, n, o) : Math.abs(e.successProbability - n.successProbability) > Te ? n.successProbability - e.successProbability : Nn(e, n, o);
}
function $v(e, n) {
	const i = /* @__PURE__ */ new Map(), o = /* @__PURE__ */ new Map(), t = e.actualStockUses || e.stockUses, r = e.stock || {
		blue: t.blue * 10,
		purple: t.purple * 10,
		yellow: t.yellow * 10
	}, a = Di(e.strategy), u = {
		dynamicCapReductions: 0,
		dynamicCapFallbacks: 0
	};
	let l = 0;
	function c(s, f) {
		const m = s;
		if (he(m)) return {
			successProbability: 1,
			maxSuccessProbability: 1,
			probabilityGap: 0,
			pressure: 0,
			vector: {
				blue: 0,
				purple: 0,
				yellow: 0
			},
			firstAction: null
		};
		if ($e(m)) return c(ne(), f);
		if (f = Sn(m, f, u), f.blue <= 0 && f.purple <= 0 && f.yellow <= 0) return {
			successProbability: 0,
			maxSuccessProbability: 0,
			probabilityGap: 0,
			pressure: 0,
			vector: {
				blue: 0,
				purple: 0,
				yellow: 0
			},
			firstAction: null
		};
		const g = oo(m, f);
		if (i.has(g)) return i.get(g);
		l += 1, n && l % 5e4 === 0 && n({
			phase: "mdp",
			scanned: l,
			total: null
		});
		const I = [];
		let U = 0;
		for (const A of Q) {
			if (f[A] <= 0) continue;
			const ce = Je(f, A), O = je(m, A), z = c(O.success, ce), j = c(O.fail, ce), V = ao(O.probability, z.vector, j.vector, A), le = O.probability * z.successProbability + (1 - O.probability) * j.successProbability, q = O.probability * z.maxSuccessProbability + (1 - O.probability) * j.maxSuccessProbability;
			q > U && (U = q);
			const pt = uo(V, t), _n = lo(V, r), gd = {
				firstAction: A,
				successProbability: le,
				actionMaxSuccessProbability: q,
				pressure: pt,
				supplyCost: _n,
				availabilityCost: _n,
				legacySupplyCost: co(V),
				resourceCost: so(pt, _n, a),
				vector: V,
				edge: O
			};
			I.push(gd);
		}
		for (const A of I) A.maxSuccessProbability = U, A.probabilityGap = Math.max(0, U - A.successProbability);
		const N = gv(I, U, a);
		return i.set(g, N), o.set(g, N ? N.firstAction : null), N;
	}
	return {
		...c(e.start, e.stockUses),
		states: i.size,
		dynamicCapReductions: u.dynamicCapReductions,
		dynamicCapFallbacks: u.dynamicCapFallbacks,
		actionFor: (s, f) => {
			const m = ae(s), g = Sn(m, f);
			return o.get(oo(m, g)) || null;
		},
		valueForAction: (s, f, m) => {
			const g = ae(s), I = Sn(g, f);
			if (I[m] <= 0) return null;
			const U = c(g, I), N = je(g, m), A = Je(I, m), ce = c(N.success, A), O = c(N.fail, A), z = ao(N.probability, ce.vector, O.vector, m), j = N.probability * ce.successProbability + (1 - N.probability) * O.successProbability, V = U ? U.maxSuccessProbability : j, le = uo(z, t), q = lo(z, r), pt = co(z);
			return {
				name: lv[a].label,
				firstAction: m,
				firstProbability: N.probability,
				success: N.success,
				fail: N.fail,
				successProbability: j,
				maxSuccessProbability: V,
				probabilityGap: Math.max(0, V - j),
				pressure: le,
				supplyCost: q,
				availabilityCost: q,
				legacySupplyCost: pt,
				resourceCost: so(le, q, a),
				vector: z,
				totalKits: Dn(z)
			};
		}
	};
}
function _v(e, n, i = 8) {
	const o = [];
	let t = ae(e.start), r = { ...e.stockUses };
	for (let a = 0; a < i && !he(t); a += 1) {
		if ($e(t)) {
			o.push({
				state: be(t),
				kit: "convert",
				probability: 1,
				success: be(ne()),
				fail: be(ne()),
				stockBefore: { ...r }
			}), t = ne();
			continue;
		}
		const u = n(t, r);
		if (!u || r[u] <= 0) break;
		const l = je(t, u);
		o.push({
			state: be(t),
			kit: u,
			probability: l.probability,
			success: be(l.success),
			fail: be(l.fail),
			stockBefore: { ...r }
		}), r = Je(r, u), t = l.fail;
	}
	return o;
}
function bv(e, n, i = 100) {
	return vd(e, n, n(ae(e.start), { ...e.stockUses }), i);
}
function vd(e, n, i, o = 100) {
	let t = ae(e.start), r = { ...e.stockUses };
	if (!i || r[i] <= 0) return null;
	const a = je(t, i).success;
	let u = 0, l = 1;
	for (; u < o && !he(t) && !$e(t) && r[i] > 0 && !(u > 0 && n(t, r) !== i);) {
		const c = je(t, i);
		if (xt(c.success) !== xt(a)) break;
		u += 1, l *= 1 - c.probability, r = Je(r, i);
		const s = c.fail, f = s.grade !== t.grade || s.level !== t.level;
		if (t = s, f) break;
	}
	return {
		kit: i,
		count: u,
		success: a,
		fail: t,
		greatSuccessProbability: 1 - l,
		noGreatSuccessProbability: l
	};
}
function yv(e) {
	let n = e >>> 0;
	return function() {
		return n = n * 1664525 + 1013904223 >>> 0, n / 4294967296;
	};
}
function kv(e, n, i = 12e3, o = 20260505) {
	const t = yv(o), r = {
		blue: 0,
		purple: 0,
		yellow: 0
	};
	let a = 0;
	for (let u = 0; u < i; u += 1) {
		let l = ae(e.start), c = { ...e.stockUses };
		const s = {
			blue: 0,
			purple: 0,
			yellow: 0
		};
		for (let f = 0; f < 1e3; f += 1) {
			if (he(l)) {
				a += 1;
				break;
			}
			if ($e(l)) {
				l = ne();
				continue;
			}
			const m = n(l, c);
			if (!m || c[m] <= 0) break;
			c = Je(c, m), s[m] += 10;
			const g = je(l, m);
			l = t() < g.probability ? g.success : g.fail;
		}
		for (const f of Q) r[f] += s[f];
	}
	return {
		runs: i,
		completed: a,
		successProbability: a / i,
		vector: {
			blue: r.blue / i,
			purple: r.purple / i,
			yellow: r.yellow / i
		}
	};
}
function Sv(e) {
	const n = e.start && e.start.grade === "SR" ? "SR" : "R", i = jn[n], o = md(Math.floor((Number(e.start?.exp) || 0) / 100) * 100, 0, i - 100), t = fv(e.stock || {}), r = pv(t);
	return {
		start: ae({
			grade: n,
			level: e.start ? e.start.level : 0,
			exp: o
		}),
		strategy: Di(e.strategy),
		stock: t,
		actualStockUses: r,
		stockUses: {
			blue: Math.min(r.blue, te.blue),
			purple: Math.min(r.purple, te.purple),
			yellow: Math.min(r.yellow, te.yellow)
		},
		requiredExp: jn
	};
}
function Iv(e, n) {
	const i = Sv(e), o = Math.max(0, Math.floor(Number(e?.monteCarloRuns) || 0)), t = Math.max(0, Math.floor(Number(e?.monteCarloSeed) || 20260505));
	if (n && n({
		phase: "build",
		scanned: 0,
		total: 1
	}), he(i.start)) return {
		terminal: !0,
		input: i,
		message: "이미 SR 15레벨입니다."
	};
	if ($e(i.start)) return {
		possible: !0,
		convertOnly: !0,
		input: i,
		best: {
			name: "등급 전환",
			firstAction: "convert",
			firstProbability: 1,
			success: ne(),
			fail: ne(),
			vector: {
				blue: 0,
				purple: 0,
				yellow: 0
			},
			totalKits: 0,
			successProbability: 1,
			pressure: 0
		},
		route: [],
		monteCarlo: {
			runs: 0,
			completed: 0,
			successProbability: 1,
			vector: {
				blue: 0,
				purple: 0,
				yellow: 0
			}
		},
		stats: {
			states: 0,
			exact: !0,
			tolerance: 0,
			iterations: 0
		},
		topCandidates: []
	};
	if (i.stockUses.blue + i.stockUses.purple + i.stockUses.yellow <= 0) return {
		possible: !1,
		input: i,
		message: "사용 가능한 키트가 없습니다. 각 키트는 10개 단위로만 사용할 수 있습니다."
	};
	const r = $v(i, n), a = r.firstAction;
	if (!a) return {
		possible: !1,
		input: i,
		message: "현재 보유 키트로 가능한 행동이 없습니다."
	};
	const u = Q.map((m) => r.valueForAction(i.start, i.stockUses, m)).filter(Boolean).sort((m, g) => hv(m, g, r.maxSuccessProbability, i.strategy)), l = u.find((m) => m.firstAction === a) || u[0], c = bv(i, r.actionFor), s = _v(i, r.actionFor), f = o > 0 ? kv(i, r.actionFor, o, t) : {
		runs: 0,
		completed: 0,
		successProbability: l.successProbability,
		vector: {
			blue: 0,
			purple: 0,
			yellow: 0
		}
	};
	return n && n({
		phase: "done",
		scanned: 1,
		total: 1
	}), {
		possible: !0,
		terminal: !1,
		input: i,
		candidateCount: u.length,
		best: {
			name: "보유량 유한 MDP",
			firstAction: l.firstAction,
			firstProbability: l.firstProbability,
			run: c,
			success: l.success,
			fail: l.fail,
			vector: l.vector,
			totalKits: l.totalKits,
			successProbability: l.successProbability,
			maxSuccessProbability: l.maxSuccessProbability,
			probabilityGap: l.probabilityGap,
			pressure: l.pressure,
			supplyCost: l.supplyCost,
			availabilityCost: l.availabilityCost,
			legacySupplyCost: l.legacySupplyCost,
			resourceCost: l.resourceCost
		},
		route: s,
		monteCarlo: f,
		stats: {
			states: r.states,
			exact: !0,
			tolerance: 0,
			probabilityTolerance: pd(i.strategy),
			maxSuccessProbability: r.maxSuccessProbability,
			dynamicCapReductions: r.dynamicCapReductions,
			dynamicCapFallbacks: r.dynamicCapFallbacks,
			strategy: i.strategy,
			supplyAvailability: _t,
			iterations: 0
		},
		topCandidates: u.map((m) => ({
			name: m.name,
			firstAction: m.firstAction,
			run: vd(i, r.actionFor, m.firstAction),
			vector: Object.fromEntries(Q.map((g) => [g, Y(m.vector[g], 4)])),
			totalKits: Y(m.totalKits, 4),
			successProbability: Y(m.successProbability, 8),
			probabilityGap: Y(m.probabilityGap, 8),
			pressure: Y(m.pressure, 8),
			supplyCost: Y(m.supplyCost, 8),
			availabilityCost: Y(m.availabilityCost, 8),
			legacySupplyCost: Y(m.legacySupplyCost, 8),
			resourceCost: Y(m.resourceCost, 8)
		}))
	};
}
function $t(e) {
	self.postMessage(e);
}
self.onmessage = (e) => {
	const n = tv.safeParse(e.data || {});
	if (!n.success) {
		$t({
			type: "error",
			id: zv(e.data),
			message: "Invalid worker request."
		});
		return;
	}
	const i = n.data;
	try {
		const o = Iv(i.type === "validate" ? {
			...i.input || {},
			monteCarloRuns: Math.max(0, Math.floor(Number(i.runs) || 0)),
			monteCarloSeed: Math.max(0, Math.floor(Number(i.seed) || 20260505))
		} : i.input, (t) => {
			$t({
				type: "progress",
				id: i.id,
				progress: t
			});
		});
		$t({
			type: "result",
			id: i.id,
			result: i.type === "validate" ? o.monteCarlo : o
		});
	} catch (o) {
		$t({
			type: "error",
			id: i.id,
			message: o instanceof Error ? o.message : String(o)
		});
	}
};
function zv(e) {
	if (!e || typeof e != "object") return 0;
	const n = e.id;
	return typeof n == "number" && Number.isFinite(n) ? n : 0;
}
