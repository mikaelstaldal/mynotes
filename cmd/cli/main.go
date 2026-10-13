// Command cli is the script-oriented client for the MyNotes API.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"unicode"
	"unicode/utf8"

	"github.com/mikaelstaldal/mynotes/internal/clihttp"
)

const usage = `Usage: mynotes-cli [global flags] <command> [command flags]

Global flags (before the command):
  -help             Print help and exit successfully
  -url URL          Server base URL, including optional path (default MYNOTES_URL or http://127.0.0.1:8080)
  -token-file PATH  Read API token from a file (default MYNOTES_TOKEN_FILE)
  -token-stdin      Read API token from standard input

Token flags are optional and mutually exclusive; either overrides MYNOTES_TOKEN_FILE.
Without a token flag or MYNOTES_TOKEN_FILE, no Authorization header is sent.

Commands:
  notes list [-tags SLUG[,SLUG...]] [-limit N] [-offset N] [-sort updated|created|title] [-order asc|desc]
  notes search -q TEXT [-title-prefix] [-tags SLUG[,SLUG...]] [-limit N] [-offset N]
  notes get SLUG
  notes markdown SLUG
  tags list
  artifacts get SHA256
  icons get NAME

All commands are read-only. Token access covers the whole API; tag flags filter results.
JSON, Markdown, SVG and binary responses go to stdout unchanged; errors go to stderr.
Use shell redirection to save downloads. No Basic credentials are read or sent.
HTTP is allowed only for literal loopback addresses; remote servers require HTTPS.
Redirects and environment HTTP proxies are disabled.
`

func main() {
	if err := run(os.Args[1:], os.Stdin, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "mynotes-cli:", err)
		os.Exit(1)
	}
}

func run(args []string, stdin io.Reader, stdout io.Writer) error {
	return runContext(context.Background(), args, stdin, stdout)
}

func runContext(ctx context.Context, args []string, stdin io.Reader, stdout io.Writer) error {
	flags := flag.NewFlagSet("mynotes-cli", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	base := flags.String("url", clihttp.URLDefault(), "server base URL")
	tokenFile := flags.String("token-file", os.Getenv("MYNOTES_TOKEN_FILE"), "token file")
	tokenStdin := flags.Bool("token-stdin", false, "read token from stdin")
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			_, err := io.WriteString(stdout, usage)
			return err
		}
		return fmt.Errorf("%w\n%s", err, usage)
	}
	command := flags.Args()
	if len(command) == 0 || command[0] == "help" {
		_, err := io.WriteString(stdout, usage)
		return err
	}
	method, path, query, err := parseCommand(command)
	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			_, err := io.WriteString(stdout, usage)
			return err
		}
		return err
	}
	endpoint, err := clihttp.ParseBaseURL(*base)
	if err != nil {
		return err
	}
	tokenFileProvided := false
	flags.Visit(func(f *flag.Flag) {
		if f.Name == "token-file" {
			tokenFileProvided = true
		}
	})
	if tokenFileProvided && *tokenStdin {
		return errors.New("specify at most one of -token-file or -token-stdin")
	}
	if tokenFileProvided && *tokenFile == "" {
		return errors.New("-token-file must specify a nonempty path")
	}
	token := ""
	if *tokenFile != "" || *tokenStdin {
		tokenReader := stdin
		if !*tokenStdin {
			file, openErr := os.Open(*tokenFile)
			if openErr != nil {
				return fmt.Errorf("read token: %w", openErr)
			}
			defer func() { _ = file.Close() }()
			tokenReader = file
		}
		tokenBytes, err := io.ReadAll(io.LimitReader(tokenReader, 4097))
		if err != nil {
			return fmt.Errorf("read token: %w", err)
		}
		if len(tokenBytes) > 4096 {
			return errors.New("token input is too large")
		}
		token = strings.TrimSpace(string(tokenBytes))
		if token == "" || strings.IndexFunc(token, func(c rune) bool { return unicode.IsSpace(c) || unicode.IsControl(c) }) >= 0 {
			return errors.New("token input must contain one token")
		}
	}
	ctx, cancel := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM, syscall.SIGHUP)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, method, clihttp.APIURL(endpoint, path, query), nil)
	if err != nil {
		return err
	}
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	request.Header.Set("Accept", "application/json")
	if strings.HasPrefix(path, "/artifacts/") || strings.HasPrefix(path, "/icons/") || strings.HasSuffix(path, "/download-markdown") {
		request.Header.Set("Accept", "*/*")
	}
	client := clihttp.NewClient()
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("request: %w", err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		return fmt.Errorf("HTTP %d: %s", response.StatusCode, strings.TrimSpace(string(body)))
	}
	if response.StatusCode == http.StatusNoContent {
		return nil
	}
	_, err = io.Copy(stdout, response.Body)
	return err
}

var slugPattern = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)
var digestPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

func parseCommand(args []string) (string, string, url.Values, error) {
	bad := func() (string, string, url.Values, error) {
		return "", "", nil, fmt.Errorf("invalid command or arguments\n%s", usage)
	}
	if len(args) < 2 {
		return bad()
	}
	family, command := args[0], args[1]
	known := family == "notes" || family == "tags" || family == "artifacts" || family == "icons"
	help := func(value string) bool { return value == "-h" || value == "-help" || value == "--help" }
	if known && help(command) {
		return "", "", nil, flag.ErrHelp
	}
	supported := (family == "notes" && (command == "list" || command == "search" || command == "get" || command == "markdown")) || (family == "tags" && command == "list") || ((family == "artifacts" || family == "icons") && command == "get")
	if !supported {
		return bad()
	}
	if len(args) == 3 && help(args[2]) {
		return "", "", nil, flag.ErrHelp
	}
	q := url.Values{}
	if family == "tags" {
		if len(args) != 2 {
			return bad()
		}
		return http.MethodGet, "/tags", q, nil
	}
	if command == "get" || command == "markdown" {
		if len(args) != 3 {
			return bad()
		}
		value := args[2]
		if family == "artifacts" {
			if !digestPattern.MatchString(value) {
				return "", "", nil, errors.New("artifact SHA256 must be 64 lowercase hex characters")
			}
		} else if !slugPattern.MatchString(value) || len(value) > 100 || (family == "icons" && len(value) > 64) {
			return "", "", nil, errors.New("invalid slug or icon name")
		}
		path := "/" + family + "/" + value
		if family == "icons" {
			path = "/icons/lucide/" + value
		}
		if command == "markdown" {
			path += "/download-markdown"
		}
		return http.MethodGet, path, q, nil
	}
	flags := flag.NewFlagSet(command, flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	tags := flags.String("tags", "", "comma-separated tag slugs (AND filter)")
	limit := flags.Int("limit", 50, "page size, 1-200")
	offset := flags.Int("offset", 0, "page offset")
	var search *string
	var prefix *bool
	var sort, order *string
	if command == "search" {
		search = flags.String("q", "", "search text")
		prefix = flags.Bool("title-prefix", false, "match title prefix")
	} else {
		sort = flags.String("sort", "updated", "updated, created or title")
		order = flags.String("order", "desc", "asc or desc")
	}
	if err := flags.Parse(args[2:]); err != nil {
		return "", "", nil, err
	}
	if flags.NArg() != 0 {
		return bad()
	}
	if *limit < 1 || *limit > 200 || *offset < 0 {
		return "", "", nil, errors.New("limit must be 1-200 and offset nonnegative")
	}
	q.Set("limit", strconv.Itoa(*limit))
	q.Set("offset", strconv.Itoa(*offset))
	if search != nil {
		if strings.TrimSpace(*search) == "" || !utf8.ValidString(*search) || utf8.RuneCountInString(*search) > 200 {
			return "", "", nil, errors.New("search requires -q of 1-200 characters")
		}
		q.Set("q", *search)
		if *prefix {
			q.Set("titlePrefix", "true")
		}
	} else {
		if (*sort != "updated" && *sort != "created" && *sort != "title") || (*order != "asc" && *order != "desc") {
			return "", "", nil, errors.New("invalid sort or order")
		}
		q.Set("sort", *sort)
		q.Set("order", *order)
	}
	if *tags != "" {
		values := strings.Split(*tags, ",")
		if len(values) > 20 {
			return "", "", nil, errors.New("at most 20 tags are supported")
		}
		for _, tag := range values {
			if len(tag) > 100 || !slugPattern.MatchString(tag) {
				return "", "", nil, errors.New("tags must be comma-separated tag slugs")
			}
			q.Add("tag", tag)
		}
	}
	return http.MethodGet, "/notes", q, nil
}
