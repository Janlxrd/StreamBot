// src/services/cinemeta.ts
type CinemetaMetaPreview = {
	id: string;
	type: "movie" | "series";
	name: string;
	releaseInfo?: string;
	imdbRating?: string;
	poster?: string;
};

export default class CinemetaService {
	private baseUrl: string;

	constructor(baseUrl = "https://v3-cinemeta.strem.io") {
		this.baseUrl = baseUrl.replace(/\/+$/, "");
	}

	async resolveTitleToImdbId(
		query: string,
		type: "movie" | "series" = "movie",
		year?: number
	): Promise<string | null> {
		const results = await this.search(query, type);
		if (!results.length) return null;

		const picked = this.pickBestMatch(results, query, year);
		return picked?.id ?? null;
	}

	async search(
		query: string,
		type: "movie" | "series" = "movie"
	): Promise<CinemetaMetaPreview[]> {
		const extra = `search=${encodeURIComponent(query)}`;
		const url = `${this.baseUrl}/catalog/${type}/top/${extra}.json`;

		const response = await fetch(url, {
			method: "GET",
			headers: {
				accept: "application/json"
			}
		});

		if (!response.ok) {
			throw new Error(`Cinemeta search failed: ${response.status} ${response.statusText}`);
		}

		const data = await response.json();
		if (!data || !Array.isArray(data.metas)) {
			return [];
		}

		return data.metas.filter((item: any) =>
			item &&
			typeof item.id === "string" &&
			/^tt\d{6,10}$/i.test(item.id) &&
			typeof item.name === "string"
		);
	}

	private pickBestMatch(
		results: CinemetaMetaPreview[],
		query: string,
		year?: number
	): CinemetaMetaPreview | null {
		const normalizedQuery = this.normalize(query);

		const scored = results.map(item => {
			const normalizedName = this.normalize(item.name);
			const releaseYear = this.extractYear(item.releaseInfo);
			let score = 0;

			if (normalizedName === normalizedQuery) score += 100;
			else if (normalizedName.startsWith(normalizedQuery)) score += 70;
			else if (normalizedName.includes(normalizedQuery)) score += 50;

			const queryWords = normalizedQuery.split(" ").filter(Boolean);
			const nameWords = new Set(normalizedName.split(" ").filter(Boolean));
			for (const word of queryWords) {
				if (nameWords.has(word)) score += 5;
			}

			if (year && releaseYear) {
				if (releaseYear === year) score += 40;
				else score -= Math.min(Math.abs(releaseYear - year) * 5, 30);
			}

			const imdbRating = Number(item.imdbRating ?? 0);
			if (!Number.isNaN(imdbRating)) {
				score += imdbRating;
			}

			return { item, score };
		});

		scored.sort((a, b) => b.score - a.score);
		return scored[0]?.item ?? null;
	}

	private extractYear(releaseInfo?: string): number | null {
		if (!releaseInfo) return null;
		const match = releaseInfo.match(/\b(19|20)\d{2}\b/);
		return match ? Number(match[0]) : null;
	}

	private normalize(value: string): string {
		return value
			.toLowerCase()
			.replace(/[^\p{L}\p{N}\s]/gu, " ")
			.replace(/\s+/g, " ")
			.trim();
	}
}
