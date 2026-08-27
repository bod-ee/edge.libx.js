// process.env.TZ = 'UTC';

module.exports = {
    roots: [
        "<rootDir>"
    ],
    transform: {
        "^.+\\.jsx?$": "babel-jest",
        "^.+\\.ts?$": "ts-jest"
    },
    testRegex: "(/__tests__/.*|/tests/.*(\\.|/)(test|spec))\\.ts$|/src/.*\.test\.ts",
    moduleFileExtensions: [
        "ts",
        "tsx",
        "js",
        "jsx",
        "json",
        "node"
    ],
    verbose: true,
    reporters: ["default", "jest-junit"],
    coverageDirectory: ".tmp/coverage",
    // Kept here, not under a `jest` key in package.json: two config sources make jest
    // abort with "Multiple configurations found" and `bun run test` fails outright.
    coverageReporters: ["cobertura", "html"],
    transformIgnorePatterns: [
        "<rootDir>/node_modules/(?!libx\.js/.*)"
    ],
}