type TmdbMovie = {
	id: number;
	title: string;
	original_title?: string;
	release_date?: string;
	popularity?: number;
	vote_average?: number;
	vote_count?: number;
	genre_ids?: number[];
};

type TmdbMovieListResponse = {
	results?: TmdbMovie[];
};

type TmdbGenre = {
	id: number;
	name: string;
};

type TmdbGenreListResponse = {
	genres?: TmdbGenre[];
};

export default class TmdbService {
	private apiKey: string;
	private baseUrl: string;

	constructor(apiKey: string, baseUrl = "https://api.themoviedb.org/3") {
		this.apiKey = apiKey;
		this.baseUrl = baseUrl.replace(/\/+$/, "");
	}

	private getHeaders(): Record<string, string> {
		return {
			accept: "application/json",
			Authorization: `Bearer ${this.apiKey}`
		};
	}

	async getMovieGenres(): Promise<TmdbGenre[]> {
		const url = `${this.baseUrl}/genre/movie/list?language=en-US`;

		const response = await fetch(url, {
			method: "GET",
			headers: this.getHeaders()
		});

		if (!response.ok) {
			throw new Error(`TMDb genre request failed: ${response.status} ${response.statusText}`);
		}

		const data = (await response.json()) as TmdbGenreListResponse;
		return Array.isArray(data.genres) ? data.genres : [];
	}

	async getDiscoverReleasedMovies(options?: {
		page?: number;
		minYear?: number;
		genreIds?: number[];
	}): Promise<TmdbMovie[]> {
		const page = options?.page ?? 1;
		const today = new Date().toISOString().slice(0, 10);

		const params = new URLSearchParams({
			include_adult: "false",
			include_video: "false",
			language: "en-US",
			page: String(page),
			sort_by: "popularity.desc",
			"primary_release_date.lte": today,
			"vote_count.gte": "200"
		});

		if (options?.minYear) {
			params.set("primary_release_date.gte", `${options.minYear}-01-01`);
		}

		if (options?.genreIds?.length) {
			params.set("with_genres", options.genreIds.join(","));
		}

		const url = `${this.baseUrl}/discover/movie?${params.toString()}`;

		const response = await fetch(url, {
			method: "GET",
			headers: this.getHeaders()
		});

		if (!response.ok) {
			throw new Error(`TMDb discover request failed: ${response.status} ${response.statusText}`);
		}

		const data = (await response.json()) as TmdbMovieListResponse;
		return Array.isArray(data.results) ? data.results : [];
	}

	pickRandomMovie(movies: TmdbMovie[]): TmdbMovie | null {
		if (!movies.length) return null;
		const index = Math.floor(Math.random() * movies.length);
		return movies[index] ?? null;
	}

	formatMovieQuery(movie: TmdbMovie): string {
		const year = movie.release_date?.slice(0, 4);
		return year ? `${movie.title} ${year}` : movie.title;
	}

	async resolveGenreIdsByName(names: string[]): Promise<number[]> {
		if (!names.length) return [];

		const allGenres = await this.getMovieGenres();
		const normalizedWanted = names.map(name => name.toLowerCase());

		return allGenres
			.filter(genre => normalizedWanted.includes(genre.name.toLowerCase()))
			.map(genre => genre.id);
	}
}
