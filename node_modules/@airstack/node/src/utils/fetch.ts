import { request } from 'https';

type Fetch = (
  url: string,
  options: Record<string, any>
) => Promise<{
  json: () => any;
}>;

export default function fetch(
  url: string,
  options: Record<string, any>
): ReturnType<Fetch> {
  return new Promise((resolve, reject) => {
    const req = request(url, options, (res) => {
      const data: any[] = [];

      res.on('data', (chunk) => {
        data.push(chunk);
      });

      res.on('end', () => {
        let dataObject: any = null;
        let error: string | null = null;
        const dataString = Buffer.concat(data).toString();
        try {
          dataObject = JSON.parse(dataString);
        } catch {
          error = dataString;
        }
        resolve({
          json: () => (error ? { error } : dataObject),
        });
      });
    }).on('error', (error) => {
      const errorMessage = typeof error === 'string' ? error : error.message;
      reject(errorMessage || 'Something went wrong');
    });

    req.write(options.body);
    req.end();
  });
}
