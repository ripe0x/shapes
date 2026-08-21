// react-dom 19.2's dev build logs component renders to the Performance panel and serializes
// prop diffs with JSON.stringify, which throws on props containing an array of bigints
// (addValueToProperties, PRIMITIVE_ARRAY branch) and crashes the tree. The track is enabled
// only if console.timeStamp exists when react-dom's module scope runs, so remove it first.
// Import this before react/react-dom in every entry that renders bigint-array props.
// Remove once react-dom serializes bigint arrays without throwing.
delete (console as {timeStamp?: unknown}).timeStamp;

export {};
