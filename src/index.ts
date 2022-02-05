import { axiosHttpClientEnv } from "./utils/axiosUtils";
import { pipe } from "fp-ts/lib/function";
import * as T from "fp-ts/Task";
import * as E from "fp-ts/Either";
import * as IO from "fp-ts/IO";
import * as D from "io-ts";
import { pipeline } from "stream";
import { inspect } from "util";
import { fromEvent, of } from "rxjs";
import { observable, observableEither } from "fp-ts-rxjs";
import { tryParseChunkToJson } from "./stream/tweetStreamTransforms";

import "dotenv/config";

import { twitterAPIService } from "./stream/twitterStreamAPI";
import {
  decodeTransformStream,
  parseToJson,
  stringifyStream,
} from "./stream/tweetStreamTransforms";
import { NewError } from "./Error/Error";

import { capDelay, constantDelay, limitRetries, Monoid } from "retry-ts";
import { retrying } from "retry-ts/Task";
import { reconnectStream } from "./utils/reconnect";
import { StreamIdDecoder, Tweet } from "./types";
import { TweetDecoder } from "./decoders";
import { DecodeError } from "io-ts/lib/DecodeError";

console.log(process.env.BEARER_TOKEN);
const streamAPI = twitterAPIService(axiosHttpClientEnv);

const policy = capDelay(
  2000,
  Monoid.concat(constantDelay(500), limitRetries(10))
);

// create new 'retrying' instances for each reconnect logic
// call them sequentially based on fail conditions
const connectToStream = retrying(
  policy,
  (status) => {
    console.log(status);
    return streamAPI.connectToTweetStream;
  },
  E.isLeft
);

// TODO put this inside of a main IO function

const main = IO.of<T.Task<void>>(() =>
  connectToStream().then((streamEither) => {
    pipe(
      streamEither,
      E.foldW(
        async (e: NewError) => {
          console.log(inspect(e));
          switch (e._tag) {
            case "HttpResponseStatusError":
              const stream = await reconnectStream(e)();
              console.log("failed after retries");
              if (E.isLeft(stream)) main()();
              else break;
            default:
              console.log("unexpected error: re-running main " + e);
              main()();
          }
        },
        (stream) => {
          const tweets$ = fromEvent(stream, "data");
          const error$ = fromEvent(stream, "error");

          const fb = pipe(
            tweets$,
            observable.map(tryParseChunkToJson),
            observable.map(TweetDecoder.decode)
          );
          const x = fb.subscribe((data) => console.log(data));
          const errorObserver = error$.subscribe((err) => {
            console.log("an error was detected: " + err);
            x.unsubscribe();
            errorObserver.unsubscribe();
          });
        }

        /* 
                E.tryCatchK(
                  () => JSON.parse(a) as string,
                  (e) => "heartbeat"
                ) */

        /* pipeline(
            stream,
            parseToJson,
            decodeTransformStream(TweetDecoder),
            stringifyStream,
            process.stdout,
            (err) => console.error("stream closed", err)
          ) */
      )
    );
  })
);

main()();
