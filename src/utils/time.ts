export function timeStringToSeconds(timeString: string): number {
    if (!timeString.includes(":")) {
        throw new Error("Invalid time string");
    }
    let timeArray = timeString.split(":"),
        seconds = 0,
        m = 1;

    while (timeArray.length > 0) {
        const digit = parseInt(timeArray.pop());
        seconds += m * digit;
        m *= 60;
    }

    return seconds;
}
