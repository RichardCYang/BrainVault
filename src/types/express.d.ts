declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        username: string;
        name: string | null;
        avatarData: string | null;
        preferredLanguage: string | null;
        defaultCollectionIcon: string | null;
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
