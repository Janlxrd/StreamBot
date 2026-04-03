type TmdbMovie = {
	id: number;
	title: string;
	original_title?: string;
	release_date?: string;
	popularity?: number;
	vote_average?: number;
	vote_count?: number;
};

type TmdbMovieListResponse = {
	results?: TmdbMovie[];
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

	async getTopRatedReleasedMovies(page = 1): Promise<TmdbMovie[]> {
		const url = `${this.baseUrl}/movie/top_rated?language=en-US&page=${page}`;

		const response = await fetch(url, {
			method: "GET",
			headers: this.getHeaders()
		});

		if (!response.ok) {
			throw new Error(`TMDb top rated request failed: ${response.status} ${response.statusText}`);
		}

		const data = (await response.json()) as TmdbMovieListResponse;
		return Array.isArray(data.results) ? data.results : [];
	}

	async getDiscoverReleasedMovies(page = 1): Promise<TmdbMovie[]> {
		const today = new Date().toISOString().slice(0, 10);
		const params = new URLSearchParams({
			include_adult: "false",
			include_video: "false",
			language: "en-US",
			page: String(page),
			sort_by: "vote_average.desc",
			"vote_count.gte": "5000",
			"primary_release_date.lte": today
		});

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
}
