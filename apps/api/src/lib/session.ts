export type Session = {
  user: {
    id: string;
    name: string;
    email: string;
    isSuperAdmin?: boolean | null;
  };
};

export type GetSession = (headers: Headers) => Promise<Session | null>;
