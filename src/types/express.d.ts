declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        username: string;
        name: string | null;
      };
      validated?: {
        body?: unknown;
        params?: unknown;
        query?: unknown;
      };
    }
  }
}

export {};
