import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl as presign } from '@aws-sdk/s3-request-presigner';

export interface Storage {
  put(key: string, body: Buffer, contentType: string): Promise<string>;
  get(key: string): Promise<Buffer>;
  getSignedUrl(key: string, expiresInSeconds: number): Promise<string>;
}

export interface R2StorageOptions {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export function createR2Storage(options: R2StorageOptions): Storage {
  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${options.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
    },
  });

  return {
    async put(key, body, contentType) {
      await client.send(
        new PutObjectCommand({ Bucket: options.bucket, Key: key, Body: body, ContentType: contentType })
      );
      return key;
    },
    async get(key) {
      const res = await client.send(new GetObjectCommand({ Bucket: options.bucket, Key: key }));
      const bytes = await res.Body!.transformToByteArray();
      return Buffer.from(bytes);
    },
    async getSignedUrl(key, expiresInSeconds) {
      return presign(client, new GetObjectCommand({ Bucket: options.bucket, Key: key }), { expiresIn: expiresInSeconds });
    },
  };
}

export function createInMemoryStorage(): Storage {
  const store = new Map<string, Buffer>();
  return {
    async put(key, body) {
      store.set(key, body);
      return key;
    },
    async get(key) {
      const value = store.get(key);
      if (!value) throw new Error(`No object stored for key ${key}`);
      return value;
    },
    async getSignedUrl(key, expiresInSeconds) {
      return `memory://${key}?expires=${expiresInSeconds}`;
    },
  };
}
