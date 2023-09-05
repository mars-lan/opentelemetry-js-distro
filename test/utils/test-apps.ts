import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { existsSync, unlinkSync } from 'fs';
import waitOn from 'wait-on';
import { Span, readSpanDump } from './spans';
import { sleep } from './time';

const WAIT_ON_INITIAL_DELAY = 1_000;
const WAIT_ON_TIMEOUT = 10_000;
const PORT_REGEX = new RegExp('.*([Ll]istening on port )([0-9]*)', 'g');

export class TestApp {

    private spanDumpPath: string;
    private portPromise: Promise<Number>;
    private closePromise: Promise<void>;
    private app: ChildProcessWithoutNullStreams;

    constructor(
        cwd: string,
        serviceName: string,
        spanDumpPath: string,
        env_vars = {}
    ) {
        if (existsSync(spanDumpPath)) {
            console.info(`removing previous span dump file ${spanDumpPath}...`)
            unlinkSync(spanDumpPath);
        }

        console.info(`starting test app with span dump file ${spanDumpPath}...`);
        this.app = spawn('npm', ['run', 'start'], {
            cwd,
            env: {
                ...process.env, ...{
                    OTEL_SERVICE_NAME: serviceName,
                    LUMIGO_DEBUG_SPANDUMP: spanDumpPath,
                    LUMIGO_DEBUG: String(true),
                    ...env_vars
                }
            },
            shell: true,
        });

        this.spanDumpPath = spanDumpPath;

        let portResolveFunction: Function;
        this.portPromise = new Promise((resolve) => {
            portResolveFunction = resolve;
        })

        let portPromiseResolved = false;
        this.app.stderr.on('data', (data) => {
            const dataStr = data.toString();

            if (!portPromiseResolved) {
                const portRegexMatch = PORT_REGEX.exec(dataStr);

                if (portRegexMatch && portRegexMatch.length >= 3) {
                    portPromiseResolved = true;
                    portResolveFunction(parseInt(portRegexMatch[2]));
                }
            }

            console.info('spawn data stderr: ', dataStr);
        });

        let closeResolveFunction: Function;
        let closeRejectFunction: Function;
        this.closePromise = new Promise((resolve, reject) => {
            closeResolveFunction = resolve;
            closeRejectFunction = reject;
        });

        this.app.on('error', (error) => {
            closeRejectFunction(error);
        });
        this.app.on('exit', function (exitCode, signal) {
            if (signal && signal !== 'SIGTERM') {
                closeRejectFunction(new Error(`app with pid '${this.pid}' terminated unexpectedly!`));
            } else {
                const appExitMessage = `app with pid '${this.pid}' exited with signal '${signal}' and exit code '${exitCode}'`;
                console.info(appExitMessage);
                closeResolveFunction();
            }
            portPromiseResolved = true;
            portResolveFunction(-1);
        });
    }

    public pid(): Number {
        return this.app.pid!
    }

    public async port(): Promise<Number> {
        const port = Number(await this.portPromise);
        if (port < 0) {
            throw new Error(`app with pid '${this.pid()}' exited unexpectedly!`);
        }
        return port;
    }

    public async waitUntilReady(): Promise<void> {
        await this.port();
    }

    public async invokeGetPath(path: string): Promise<void> {
        const port = await this.port()

        const url = `http-get://localhost:${port}/${path.replace(/^\/+/, '')}`;

        return new Promise<void>((resolve, reject) => {
            console.info(`invoking url: ${url} ...`);
            waitOn(
                {
                    resources: [url],
                    delay: WAIT_ON_INITIAL_DELAY,
                    timeout: WAIT_ON_TIMEOUT,
                    simultaneous: 1,
                    log: true,
                    validateStatus: function (status: number) {
                        console.info(`received status: ${status}`);
                        return status >= 200 && status < 300; // default if not provided
                    },
                },
                async function (err: Error) {
                    if (err) {
                        return reject(err)
                    } else {
                        resolve();
                    }
                }
            );
        });
    }
    public async invokeGetPathAndRetrieveSpanDump(path: string): Promise<Span[]> {
        const port = await this.port()

        const url = `http-get://localhost:${port}/${path.replace(/^\/+/, '')}`;
        const spanDumpPath = this.spanDumpPath;

        return new Promise<Span[]>((resolve, reject) => {
            console.info(`invoking url: ${url} and waiting for span dump...`);
            waitOn(
                {
                    resources: [url],
                    delay: WAIT_ON_INITIAL_DELAY,
                    timeout: WAIT_ON_TIMEOUT,
                    simultaneous: 1,
                    log: true,
                    validateStatus: function (status: number) {
                        console.info(`received status: ${status}`);
                        return status >= 200 && status < 300; // default if not provided
                    },
                },
                async function (err: Error) {
                    if (err) {
                        return reject(err)
                    } else {
                        resolve(readSpanDump(spanDumpPath));
                    }
                }
            );
        });
    }

    public async getFinalSpans(expectedNumberOfSpans: number | null = null, timeout: number | null = 3_000): Promise<Span[]> {
            const spanDumpPath = this.spanDumpPath;

            let spans = readSpanDump(spanDumpPath)

            if (!expectedNumberOfSpans) {
                return spans;
            }

            const sleepTime = 500;
            let timeoutRemaining = timeout || 10_000;
            while (spans.length < expectedNumberOfSpans && timeoutRemaining > 0) {
                await sleep(sleepTime);
                timeoutRemaining -= sleepTime;
                spans = readSpanDump(spanDumpPath);
            }

            return spans;
    }

    public async kill(): Promise<number | null> {
        try {
            console.info(`ensuring app with pid '${this.pid()}' and exit code '${this.app.exitCode})' killed...`);
            this.app.kill();
        } catch (err) {
            console.warn(`error killing app with pid '${this.pid()}' and exit code '${this.app.exitCode})'`, err);
        }

        await this.closePromise;
        return this.app.exitCode
    }
}
