class StremioAddonService {
	private addonBaseUrl: string;

	constructor(addonUrl: string) {
		this.addonBaseUrl = addonUrl
			.replace(/\/manifest\.json$/i, "")
			.replace(/\/+$/, "");
	}

	extractImdbId(input: string): string | null {
		const trimmed = input.trim();

		const directMatch = trimmed.match(/\btt\d{6,10}\b/i);
		if (directMatch) return directMatch[0].toLowerCase();

		const imdbUrlMatch = trimmed.match(/imdb\.com\/title\/(tt\d{6,10})/i);
		if (imdbUrlMatch) return imdbUrlMatch[1].toLowerCase();

		return null;
	}

	async getMovieStreams(imdbId: string): Promise<any[]> {
		const url = `${this.addonBaseUrl}/stream/movie/${encodeURIComponent(imdbId)}.json`;

		const response = await fetch(url, {
			method: "GET",
			headers: { accept: "application/json" }
		});

		if (!response.ok) {
			throw new Error(`Stremio addon request failed: ${response.status} ${response.statusText}`);
		}

		const data = await response.json();
		if (!data || !Array.isArray(data.streams)) return [];

		return data.streams;
	}

	filterEnglishStreams(streams: any[]): any[] {
		if (!streams.length) return [];

		const englishPatterns = [
			/\benglish\b/i,
			/\beng\b/i,
			/\ben\b/i,
			/\bdual[ -]?audio\b.*\beng(?:lish)?\b/i,
			/\bsub(?:bed)?\b.*\beng(?:lish)?\b/i,
			/\bdub(?:bed)?\b.*\beng(?:lish)?\b/i
		];

		const foreignOnlyPatterns = [
			/\bspanish\b/i,
			/\besp[aá]nol\b/i,
			/\blatino\b/i,
			/\bfrench\b/i,
			/\bgerman\b/i,
			/\bitalian\b/i,
			/\bportuguese\b/i,
			/\brussian\b/i,
			/\bpolish\b/i,
			/\bturkish\b/i,
			/\bhindi\b/i,
			/\bjapanese\b/i,
			/\bkorean\b/i,
			/\bthai\b/i,
			/\bvietnamese\b/i
		];

		const getText = (stream: any) =>
			[
				stream.name,
				stream.title,
				stream.description,
				stream.behaviorHints?.filename
			]
				.filter(Boolean)
				.join(" ");

		const explicitEnglish = streams.filter(stream => {
			const text = getText(stream);
			return englishPatterns.some(rx => rx.test(text));
		});

		if (explicitEnglish.length) return explicitEnglish;

		const notObviouslyForeign = streams.filter(stream => {
			const text = getText(stream);
			return !foreignOnlyPatterns.some(rx => rx.test(text));
		});

		return notObviouslyForeign.length ? notObviouslyForeign : [];
	}

	private getCombinedText(stream: any): string {
		return [
			stream.name,
			stream.title,
			stream.description,
			stream.behaviorHints?.filename
		]
			.filter(Boolean)
			.join(" ");
	}

	private getResolutionRank(stream: any): number {
		const text = this.getCombinedText(stream);

		if (/\b(1080p|1080|fullhd|fhd)\b/i.test(text)) return 2;
		if (/\b(720p|720|hd)\b/i.test(text)) return 1;

		return 0;
	}

	private parseSizeToMB(stream: any): number {
		const possibleValues = [
			stream.size,
			stream.fileSize,
			stream.sizeBytes,
			stream.behaviorHints?.videoSize,
			this.getCombinedText(stream)
		];

		for (const value of possibleValues) {
			const parsed = this.extractSizeToMB(value);
			if (parsed !== null) return parsed;
		}

		return Number.POSITIVE_INFINITY;
	}

	private extractSizeToMB(value: any): number | null {
		if (value == null) return null;

		if (typeof value === "number" && Number.isFinite(value)) {
			if (value > 1024 * 1024) {
				return value / (1024 * 1024);
			}
			return value;
		}

		if (typeof value !== "string") return null;

		const match = value.match(/(\d+(?:\.\d+)?)\s*(kb|mb|gb|tb|kib|mib|gib|tib)\b/i);
		if (!match) return null;

		const amount = Number(match[1]);
		const unit = match[2].toLowerCase();

		switch (unit) {
			case "kb":
			case "kib":
				return amount / 1024;
			case "mb":
			case "mib":
				return amount;
			case "gb":
			case "gib":
				return amount * 1024;
			case "tb":
			case "tib":
				return amount * 1024 * 1024;
			default:
				return null;
		}
	}

	private isDirectPlayableUrl(url: string): boolean {
		const clean = url.split("?")[0].toLowerCase();

		// accept typical direct files
		if (/\.(mp4|mkv|webm|mov|m4v|avi|ts)$/.test(clean)) {
			return true;
		}

		// reject manifest-style URLs for now
		if (/\.(m3u8|mpd)$/.test(clean)) {
			return false;
		}

		// unknown direct URL: allow, but lower confidence
		return true;
	}

	private isPlayableByYourBot(stream: any): boolean {
		if (typeof stream.ytId === "string" && stream.ytId.length > 0) {
			return true;
		}

		if (typeof stream.url !== "string" || !stream.url.length) {
			return false;
		}

		// if Stremio says this is not web-ready, skip it unless you implement proxy/header support
		if (stream.behaviorHints?.notWebReady === true) {
			return false;
		}

		// if headers are required, skip it for now
		if (stream.behaviorHints?.proxyHeaders) {
			return false;
		}

		return this.isDirectPlayableUrl(stream.url);
	}

	pickBestPlayableHighQualityEnglishStream(streams: any[]): any | null {
		if (!streams.length) return null;

		const playable = streams.filter(stream => this.isPlayableByYourBot(stream));
		if (!playable.length) return null;

		const withQuality = playable
			.map(stream => ({
				stream,
				resolutionRank: this.getResolutionRank(stream),
				sizeMB: this.parseSizeToMB(stream)
			}))
			.filter(item => item.resolutionRank > 0);

		if (!withQuality.length) return null;

		const maxRank = Math.max(...withQuality.map(item => item.resolutionRank));
		const sameQuality = withQuality.filter(item => item.resolutionRank === maxRank);

		sameQuality.sort((a, b) => a.sizeMB - b.sizeMB);

		return sameQuality[0]?.stream ?? null;
	}

	toPlayableInput(stream: any): string | null {
		if (stream.url) return stream.url;
		if (stream.ytId) return `https://www.youtube.com/watch?v=${stream.ytId}`;
		return null;
	}

	explainWhyRejected(stream: any): string | null {
		if (typeof stream.ytId === "string" && stream.ytId.length > 0) return null;

		if (typeof stream.url !== "string" || !stream.url.length) {
			return "no direct url";
		}

		if (stream.behaviorHints?.notWebReady === true) {
			return "notWebReady stream";
		}

		if (stream.behaviorHints?.proxyHeaders) {
			return "requires proxy headers";
		}

		const clean = stream.url.split("?")[0].toLowerCase();
		if (/\.(m3u8|mpd)$/.test(clean)) {
			return "manifest stream";
		}

		return null;
	}
}

export default StremioAddonService;
