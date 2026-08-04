declare global {
  namespace Express {
    interface Request {
      auth?: {
        authVersion: number;
      };
      user?: {
        id: string;
        username: string;
        name: string | null;
        avatarData: string | null;
        preferredLanguage: string | null;
        defaultCollectionIcon: string | null;
        theme: "light" | "dark";
        createdAt: string;
        updatedAt: string;
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
