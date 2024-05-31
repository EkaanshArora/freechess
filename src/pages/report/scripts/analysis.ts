import { Chess } from "chess.js";
import pgnParser from "pgn-parser";
import analyse from "../../../../src/lib/analysis";
import { EvaluatedPosition, Position } from "../../../../src/lib/types/Position";
import { isNewGame, setIsNewGame } from "./evalgraph";
import { classificationColours, traverseMoves, updateBoardPlayers } from "./board";
import { Stockfish } from "./engine";
import { classificationIcons } from "./sprites";


export let ongoingEvaluation = false;

export let evaluatedPositions: Position[] = [];
export let reportResults: Report | undefined;

function logAnalysisInfo(message: string) {
    $("#status-message").css("display", "block");

    $("#status-message").css("background", "rgba(49, 51, 56, 255)");
    $("#status-message").css("color", "white");
    $("#status-message").html(message);
}

function logAnalysisError(message: string) {
    $("#evaluation-progress-bar").css("display", "none");
    $("#secondary-message").html('');
    $("#status-message").css("padding", "10px 3px 10px 3px");
    $("#status-message").css("display", "block");
    $("#status-message").css("background", "rgba(239, 65, 70, 0.4");
    $("#status-message").css("color", "white");

    $("#status-message").html(`<i class="fa-solid fa-circle-info" style="color: #ffffff;"></i>` + message);

    ongoingEvaluation = false;
}

async function evaluate() {
    // Remove and reset CAPTCHA, remove report cards, display progress bar
    $(".g-recaptcha").css("display", "none");
    // grecaptcha.reset();

    $("#report-cards").css("display", "none");
    $("#evaluation-progress-bar").css("display", "none");




    // Disallow evaluation if another evaluation is ongoing
    if (ongoingEvaluation) return;
    ongoingEvaluation = true;

    // Extract input PGN and target depth
    let pgn = $("#pgn").val()!.toString();
    let depth = parseInt($("#depth-slider").val()!.toString());

    // Content validate PGN input
    if (pgn.length == 0) {
        return logAnalysisError("Provide a game to analyse.");
    }

    // Post PGN to server to have it parsed
    $("#status-message").css("padding", "10px 3px 10px 3px");
    logAnalysisInfo("Parsing PGN...");

    try {
        let parseResponse = await parseApi(pgn);

        let parsedPGN = await parseApi(pgn);

        if (!parseResponse.ok) {
            return logAnalysisError(
                parsedPGN.message ?? "Failed to parse PGN.",
            );
        }

        var positions = parsedPGN.positions!;
    } catch {
        return logAnalysisError("Failed to parse PGN.");
    }

    // Update board player usernames
    // whitePlayer.username =
    //     pgn.match(/(?:\[White ")(.+)(?="\])/)?.[1] ?? "White Player";
    // whitePlayer.rating = pgn.match(/(?:\[WhiteElo ")(.+)(?="\])/)?.[1] ?? "?";

    // blackPlayer.username =
    //     pgn.match(/(?:\[Black ")(.+)(?="\])/)?.[1] ?? "Black Player";
    // blackPlayer.rating = pgn.match(/(?:\[BlackElo ")(.+)(?="\])/)?.[1] ?? "?";

    updateBoardPlayers();

    $("#secondary-message").html("It can take around a minute to process a full game.");

    // Fetch cloud evaluations where possible
    for (let position of positions) {
        function placeCutoff() {
            let lastPosition = positions[positions.indexOf(position) - 1];
            if (!lastPosition) return;

            let cutoffWorker = new Stockfish();
            cutoffWorker
                .evaluate(lastPosition.fen, depth)
                .then((engineLines) => {
                    lastPosition.cutoffEvaluation = engineLines.find(
                        (line) => line.id == 1,
                    )?.evaluation ?? { type: "cp", value: 0 };
                });
        }

        let queryFen = position.fen.replace(/\s/g, "%20");
        let cloudEvaluationResponse;
        try {
            cloudEvaluationResponse = await fetch(
                `https://lichess.org/api/cloud-eval?fen=${queryFen}&multiPv=2`,
                {
                    method: "GET",
                },
            );

            if (!cloudEvaluationResponse) break;
        } catch {
            break;
        }

        if (!cloudEvaluationResponse.ok) {
            placeCutoff();
            break;
        }

        let cloudEvaluation = await cloudEvaluationResponse.json();

        position.topLines = cloudEvaluation.pvs.map((pv: any, id: number) => {
            const evaluationType = pv.cp == undefined ? "mate" : "cp";
            const evaluationScore = pv.cp ?? pv.mate ?? "cp";

            let line: EngineLine = {
                id: id + 1,
                depth: depth,
                moveUCI: pv.moves.split(" ")[0] ?? "",
                evaluation: {
                    type: evaluationType,
                    value: evaluationScore,
                },
            };

            let cloudUCIFixes: { [key: string]: string } = {
                e8h8: "e8g8",
                e1h1: "e1g1",
                e8a8: "e8c8",
                e1a1: "e1c1",
            };
            line.moveUCI = cloudUCIFixes[line.moveUCI] ?? line.moveUCI;

            return line;
        });

        if (position.topLines?.length != 2) {
            placeCutoff();
            break;
        }

        position.worker = "cloud";

        let progress =
            ((positions.indexOf(position) + 1) / positions.length) * 100;
        $("#evaluation-progress-bar").attr("value", progress);
        logAnalysisInfo(`Evaluating positions... (${progress.toFixed(1)}%)`);
    }

    // Evaluate remaining positions
    let workerCount = 0;

    const stockfishManager = setInterval(() => {
        // If all evaluations have been generated, move on

        if (!positions.some((pos) => !pos.topLines)) {
            clearInterval(stockfishManager);

            logAnalysisInfo("Evaluation complete.");
            $("#evaluation-progress-bar").val(100);
            $(".g-recaptcha").css("display", "inline");
            if (!document.hasFocus()) {
                let snd = new Audio("static/media/ping.mp3");
                snd.play();
            }
            $("#secondary-message").html(
                "Please complete the CAPTCHA to continue.",
            );

            evaluatedPositions = positions;
            ongoingEvaluation = false;
            report()
            return;
        }

        // Find next position with no worker and add new one
        for (let position of positions) {
            if (position.worker || workerCount >= 8) continue;

            let worker = new Stockfish();
            worker.evaluate(position.fen, depth).then((engineLines) => {
                position.topLines = engineLines;
                workerCount--;
            });

            position.worker = worker;
            workerCount++;
        }

        // Update progress monitor
        let workerDepths = 0;
        for (let position of positions) {
            if (typeof position.worker == "object") {
                workerDepths += position.worker.depth;
            } else if (typeof position.worker == "string") {
                workerDepths += depth;
            }
        }

        let progress = (workerDepths / (positions.length * depth)) * 100;

        $("#evaluation-progress-bar").attr("value", progress);
        logAnalysisInfo(`Evaluating positions... (${progress.toFixed(1)}%)`);
    }, 10);
}

function loadReportCards() {
    // Reset chess board, draw evaluation for starting position

    $("#status-message").css("display", "none");
    $("#status-message").css("padding", "0px");
    traverseMoves(-Infinity);

    // Reveal report cards and update accuracies
    $("#report-cards").css("display", "flex");

    if (!!reportResults) {
        $("#white-accuracy").html(`${reportResults.accuracies.white.toFixed(1)}%`);
        $("#black-accuracy").html(`${reportResults.accuracies.black.toFixed(1)}%`);

        // Initialize classification container for next analysis
        $("#classification-count-container").empty();

        // Make classification count section
        for (const classification of Object.keys(reportResults.classifications.white)) {
            if (classification === "book" || classification === "forced") continue;

            const classificationRow = $("<div>").prop({
                class: "classification-count-row"
            });

            // Create white's classification count
            const whiteClassificationCount = $("<div>").prop({
                class: "classification-count-white"
            }).css({
                color: classificationColours[classification]
            }).html(`${reportResults.classifications.white[classification as Classifications]}`);

            // Create black's classification count
            const blackClassificationCount = $("<div>").prop({
                class: "classification-count-black"
            }).css({
                color: classificationColours[classification]
            }).html(`${reportResults.classifications.black[classification as Classifications]}`);


            // Create classification icon and message
            const classificationContent = $("<div>").prop({
                class: "classification-count-content"
            });
            $(classificationIcons[classification]!).appendTo(classificationContent);
            $("<div>").html(`${classification}`)
                .css({
                    color: classificationColours[classification]
                }).appendTo(classificationContent);


            // Add white's classification count
            whiteClassificationCount.appendTo(classificationRow);

            // Add classification icon and message
            classificationContent.appendTo(classificationRow);

            // Add black's classification count
            blackClassificationCount.appendTo(classificationRow);

            // Insert classification row
            classificationRow.appendTo("#classification-count-container");
        }
    } else {
        $("#black-accuracy").html("100%");
        $("#white-accuracy").html("100%");
    }

    // Remove progress bar and any status message
    $("#evaluation-progress-bar").css("display", "none");
    $("#status-message").css("display", "none");
    logAnalysisInfo("");
}

async function report() {
    // Remove CAPTCHA

    $(".g-recaptcha").css("display", "none");
    $("#secondary-message").html("");
    $("#evaluation-progress-bar").attr("value", null);
    logAnalysisInfo("Generating report...");
    $("#status-message").css("display", "none");

    // Post evaluations and get report results
    try {
        const sendData = evaluatedPositions.map((pos) => {
            if (pos.worker != "cloud") {
                pos.worker = "local";
            }
            return pos;
        })
        let reportResponse = await reportApi(sendData);

        let report = reportResponse;

        if (!reportResponse.ok) {
            return logAnalysisError(
                report.message ?? "Failed to generate report.",
            );
        }

        // Set report results to results given by server
        reportResults = report.results!;
        $("#status-message").css("display", "none");
        loadReportCards();
    } catch {
        return logAnalysisError("Failed to generate report.");
    }
}

$("#review-button").on("click", () => {
    setIsNewGame(true);

    if ($("#load-type-dropdown").val() == "json") {
        try {
            let savedAnalysis: SavedAnalysis = JSON.parse($("#pgn").val()?.toString()!);

            whitePlayer = savedAnalysis.players.white;
            blackPlayer = savedAnalysis.players.black;
            updateBoardPlayers();

            reportResults = savedAnalysis.results;
            loadReportCards();
        } catch {
            logAnalysisError("Invalid savefile.");
        }
    } else {
        evaluate();
    }
});

$("#depth-slider").on("input", () => {
    let depth = parseInt($("#depth-slider").val()?.toString()!);

    if (depth <= 14) {
        $("#depth-counter").html(depth + `|<i class="fa-solid fa-bolt" style="color: #ffffff;"></i>`);
    } else if (depth <= 17) {
        $("#depth-counter").html(depth + `|<i class="fa-solid fa-wind" style="color: #ffffff;"></i>`);
    } else {
        $("#depth-counter").html(depth + `|<i class="fa-solid fa-hourglass-half" style="color: #ffffff;"></i>`);
    }
});


const parseApi = async (pgn: string) => {

    if (!pgn) {
        return { message: "Enter a PGN to analyse." };
    }

    // Parse PGN into object
    try {
        var [parsedPGN] = pgnParser.parse(pgn);

        if (!parsedPGN) {
            return { message: "Enter a PGN to analyse." };
        }
    } catch (err) {
        return { message: "Failed to parse invalid PGN." };
    }

    // Create a virtual board
    let board = new Chess();
    let positions: Position[] = [];

    positions.push({ fen: board.fen() });

    // Add each move to the board; log FEN and SAN
    for (let pgnMove of parsedPGN.moves) {
        let moveSAN = pgnMove.move;

        let virtualBoardMove;
        try {
            virtualBoardMove = board.move(moveSAN);
        } catch (err) {
            return { message: "PGN contains illegal moves." };
        }

        let moveUCI = virtualBoardMove.from + virtualBoardMove.to;

        positions.push({
            fen: board.fen(),
            move: {
                san: moveSAN,
                uci: moveUCI
            }
        });
    }

    return { positions: positions, ok: true };
}

const reportApi = async (positions: EvaluatedPosition[]) => {

    if (!positions) {
        console.log("No positions to report.");
        return { message: "Missing parameters.", ok: false };
    }

    // Generate report
    try {
        var results = await analyse(positions);
    } catch (err) {
        console.log("!err");
        console.log(err);
        return { message: "Failed to generate report.", ok: false };
    }
    console.log("results", results);
    return { results: results, ok: true };
}