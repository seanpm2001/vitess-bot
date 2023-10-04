/*
Copyright 2023 The Vitess Authors.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

	http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package main

import (
	"context"
	"fmt"

	"github.com/google/go-github/v53/github"
	"github.com/pkg/errors"
	"github.com/vitess.io/vitess-bot/go/git"
	"github.com/vitess.io/vitess-bot/go/shell"
)

// synchronize cobradocs from main and release branches
func synchronizeCobraDocs(
	ctx context.Context,
	client *github.Client,
	vitess *git.Repo,
	website *git.Repo,
	pr *github.PullRequest,
	prInfo prInformation,
) (*github.PullRequest, error) {
	op := "update cobradocs"
	branch := "prod"

	websiteProdRef, _, err := client.Git.GetRef(ctx, website.Owner, website.Name, "heads/"+branch)
	if err != nil {
		return nil, errors.Wrapf(err, "Failed to fetch prod ref for repository %s/%s to %s on Pull Request %d", website.Owner, website.Name, op, prInfo.num)
	}

	newBranch := fmt.Sprintf("synchronize-cobradocs-for-%d", pr.GetNumber())
	_, err = website.CreateBranch(ctx, client, websiteProdRef, newBranch)
	if err != nil {
		return nil, errors.Wrapf(err, "Failed to create git ref %s ref for repository %s/%s to %s on Pull Request %d", newBranch, website.Owner, website.Name, op, prInfo.num)
	}

	if err := setupRepo(ctx, vitess, prInfo, op); err != nil {
		return nil, err
	}

	if err := vitess.FetchRef(ctx, "origin", "--tags"); err != nil {
		return nil, errors.Wrapf(err, "Failed to fetch tags in repository %s/%s to %s on Pull Request %d", vitess.Owner, vitess.Name, op, prInfo.num)
	}

	if err := setupRepo(ctx, website, prInfo, op); err != nil {
		return nil, err
	}

	// Checkout the new branch we created.
	if err := website.Checkout(ctx, newBranch); err != nil {
		return nil, errors.Wrapf(err, "Failed to checkout repository %s/%s to branch %s to %s on Pull Request %d", website.Owner, website.Name, newBranch, op, prInfo.num)
	}

	// Run the sync script (which authors the commit already).
	_, err = shell.NewContext(ctx, "./tools/sync_cobradocs.sh").InDir(website.LocalDir).WithExtraEnv(
		fmt.Sprintf("VITESS_DIR=%s", vitess.LocalDir),
		"COBRADOCS_SYNC_PERSIST=yes",
		// `COBRADOC_VERSION_PAIRS="main:19.0"`, // here until rc becomes a real tag
	).Output()
	if err != nil {
		return nil, errors.Wrapf(err, "Failed to run cobradoc sync script in repository %s/%s to %s on Pull Request %d", website.Owner, website.Name, newBranch, prInfo.num)
	}

	// TODO: do we need to amend the commit to change the author to the bot?

	// Push the branch
	if err := website.Push(ctx, git.PushOpts{
		Remote: "origin",
		Refs:   []string{newBranch},
		Force:  true,
	}); err != nil {
		return nil, errors.Wrapf(err, "Failed to push %s to %s on Pull Request %d", newBranch, op, prInfo.num)
	}

	// Create a Pull Request for the new branch
	newPR := &github.NewPullRequest{
		Title:               github.String(fmt.Sprintf("[cobradocs] synchronize with %s (vitess#%d)", pr.GetTitle(), pr.GetNumber())),
		Head:                github.String(newBranch),
		Base:                github.String(branch),
		Body:                github.String(fmt.Sprintf("## Description\nThis is an automated PR to synchronize the cobradocs with %s", pr.GetHTMLURL())),
		MaintainerCanModify: github.Bool(true),
	}
	newPRCreated, _, err := client.PullRequests.Create(ctx, website.Owner, website.Name, newPR)
	if err != nil {
		return nil, errors.Wrapf(err, "Failed to create Pull Request using branch %s on %s/%s", newBranch, website.Owner, website.Name)
	}

	return newPRCreated, nil

}

func setupRepo(ctx context.Context, repo *git.Repo, prInfo prInformation, op string) error {
	if err := repo.Clone(ctx); err != nil {
		return errors.Wrapf(err, "Failed to clone repository %s/%s to %s on Pull Request %d", repo.Owner, repo.Name, op, prInfo.num)
	}

	if err := repo.Clean(ctx); err != nil {
		return errors.Wrapf(err, "Failed to clean the repository %s/%s to %s on Pull Request %d", repo.Owner, repo.Name, op, prInfo.num)
	}

	if err := repo.Fetch(ctx, "origin"); err != nil {
		return errors.Wrapf(err, "Failed to fetch origin on repository %s/%s to %s on Pull Request %d", repo.Owner, repo.Name, op, prInfo.num)
	}

	if err := repo.ResetHard(ctx, "HEAD"); err != nil {
		return errors.Wrapf(err, "Failed to reset the repository %s/%s to %s on Pull Request %d", repo.Owner, repo.Name, op, prInfo.num)
	}

	return nil
}
